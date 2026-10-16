// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry, MemoryDraft } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, computeContentHash } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    getLastSummarizedTimestampPerApp,
    setLastSummarizedTimestampPerApp,
    addMemoryDraft,
    removeMemoryDraft,
    addDeletedHash,
    isHashedDeleted,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import {
    loadNativeTimeline,
    formatTimelineForSummarization,
    filterTimelineByAllowedSources,
    getSummarizationSourceKey,
    summarizationSourceKeyToAppId,
    type NativeTimelineEntry,
} from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string; draftId?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // ── 按 App 分开总结（2026-10-16）─────────────────────────────
    // 1) 先按「每个来源各自的水位线」中最靠前的一个，把时间线整体拉出来；
    //    随后按来源分桶，各桶独立推进自己的水位线，互不牵连。
    const forcedAll = options?.force;
    const sinceOverride = options?.sinceTimestamp;

    // 找出所有需要处理的分桶 + 各自起点
    // 先无条件拉全量（有 afterTimestamp 时也不能只用一个水位线，否则会漏掉其他来源）
    let rawEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId),
        config.shortTermAllowedSources,
    );

    // 按分桶聚合
    const buckets = new Map<string, NativeTimelineEntry[]>();
    for (const entry of rawEntries) {
        const key = getSummarizationSourceKey(entry);
        if (!key) continue;
        // 来源开关（与 filterTimelineByAllowedSources 同源，此处二次保险）
        const arr = buckets.get(key);
        if (arr) arr.push(entry); else buckets.set(key, [entry]);
    }

    // 每个桶按自己的水位线裁剪
    const pendingBuckets: Array<{ key: string; entries: NativeTimelineEntry[]; since: string | null }> = [];
    for (const [key, entries] of buckets) {
        const prevTs = getLastSummarizedTimestampPerApp(characterId, key)
            ?? (forcedAll ? null : null);
        const floor = forcedAll ? null : (sinceOverride ?? prevTs);
        const fresh = floor
            ? entries.filter(e => e.timestamp > floor)
            : entries;
        if (fresh.length > 0) {
            pendingBuckets.push({ key, entries: fresh, since: floor });
        }
    }

    if (pendingBuckets.length === 0) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: "没有可总结的事件" };
    }

    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;

    // 2) 逐桶总结
    let summarizedBuckets = 0;
    let summarizedEvents = 0;
    let lastError: string | undefined;

    for (const bucket of pendingBuckets) {
        const { key, entries } = bucket;

        if (entries.length < 4) continue;

        const formatted = formatTimelineForSummarization(entries);
        if (!formatted) continue;
        const { eventsText, earliest, latest } = formatted;

        const summaryPrompt = promptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{earliest\}\}/gi, earliest)
            .replace(/\{\{latest\}\}/gi, latest)
            .replace(/\{\{events\}\}/gi, eventsText);

        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: summaryPrompt }],
            { temperature: 0.3, label: `记忆总结·${characterName}·${key}` },
        );

        if (!result.content) {
            lastError = result.error || "LLM 返回了空内容";
            continue;
        }
        if (result.wasTruncated) {
            console.warn("[MemorySummarizer] Summary truncated:", result.finishReason);
            lastError = "记忆总结结果疑似被截断，已取消入库";
            continue;
        }

        const summary = result.content;

        // 3) 防污染 · 指纹去重 + 墓碑
        const contentHash = computeContentHash(summary);
        if (isHashedDeleted(characterId, contentHash)) {
            console.log("[MemorySummarizer] 命中墓碑，丢弃该总结（防复活）");
            setLastSummarizedTimestampPerApp(characterId, key, latest);
            continue;
        }
        const existing = await loadMemoryEntries(characterId);
        if (existing.some(e => computeContentHash(e.content) === contentHash)) {
            console.log("[MemorySummarizer] 内容已存在（指纹去重），跳过");
            setLastSummarizedTimestampPerApp(characterId, key, latest);
            continue;
        }

        // 4) 生成 embedding（可选）
        let embedding: number[] | undefined;
        const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(summary, embeddingApiConfig);
                if (emb) embedding = emb;
            } catch { /* ignore */ }
        }

        const sourceSessionIds = Array.from(new Set(
            entries
                .map(entry => entry.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ));

        // 5) 入库（sourceApp 固定为该桶所属 App）
        const now = new Date().toISOString();
        const longTermEntry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: summarizationSourceKeyToAppId(key),
            type: "long_term",
            content: summary,
            embedding,
            importance: 0.8,
            createdAt: now,
            updatedAt: now,
            metadata: {
                summarizedEvents: entries.length,
                timeSpan: `${earliest} ~ ${latest}`,
                sourceSessionIds,
                contentHash,
                summarizationSourceKey: key,
            },
        };
        await saveMemoryEntry(longTermEntry);

        // 6) 推进该桶水位线
        setLastSummarizedTimestampPerApp(characterId, key, latest);
        summarizedBuckets += 1;
        summarizedEvents += entries.length;
    }

    if (summarizedBuckets === 0) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: lastError || "各来源事件均不足 4 条" };
    }

    // 兼容旧水位线（全局）：推进到最新，避免下次重复拉全量
    const globalLatest = pendingBuckets
        .map(b => b.entries[b.entries.length - 1]?.timestamp)
        .filter(Boolean)
        .sort()
        .pop();
    if (globalLatest) setLastSummarizedTimestamp(characterId, globalLatest);
    resetEventCounter(characterId);

    // 7) 限制长期记忆总量
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    console.log(`[MemorySummarizer] Summarized ${summarizedEvents} entries across ${summarizedBuckets} source bucket(s)`);
    return { success: true };
}

/**
 * 确认归档：把归档草稿落库为正式长期记忆（归档页「确认」时调用）。
 * 同样受防污染约束（墓碑 / 指纹去重）。
 */
export async function commitMemoryDraft(
    characterId: string,
    draft: MemoryDraft,
    editedContent?: string,
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();
    const content = (editedContent ?? draft.content).trim();
    if (!content) return { success: false, error: "内容为空" };

    const contentHash = computeContentHash(content);
    if (isHashedDeleted(characterId, contentHash)) {
        removeMemoryDraft(characterId, draft.id);
        return { success: false, error: "该内容已被标记删除，忽略" };
    }

    const existing = await loadMemoryEntries(characterId);
    if (existing.some(e => computeContentHash(e.content) === contentHash)) {
        removeMemoryDraft(characterId, draft.id);
        return { success: true };
    }

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: draft.sourceApp as MemoryEntry["sourceApp"],
        type: "long_term",
        content,
        embedding: draft.embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedEvents: draft.summarizedEvents,
            timeSpan: `${draft.earliest} ~ ${draft.latest}`,
            sourceSessionIds: draft.sourceSessionIds,
        },
    };
    await saveMemoryEntry(entry);
    removeMemoryDraft(characterId, draft.id);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    // 核心记忆已砍掉：不再累加核心计数、不再触发核心压缩
    return { success: true };
}

/**
 * 丢弃草稿：进墓碑，这段内容不再被总结复活。
 */
export function discardMemoryDraft(characterId: string, draft: MemoryDraft): void {
    addDeletedHash(characterId, draft.contentHash);
    removeMemoryDraft(characterId, draft.id);
}
