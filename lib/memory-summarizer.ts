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
    incrementCoreMemoryCounter,
    addMemoryDraft,
    removeMemoryDraft,
    addDeletedHash,
    isHashedDeleted,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

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
    // 归档确认制：自动记录已停用。记忆只能由用户在「归档」页手动提炼 → 确认后入库。
    // 保留函数签名以兼容既有调用点；此处直接返回。
    void characterId;
    void characterName;
    return;
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

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    // label 用于在「底层调用大模型日志」中标识这是记忆总结调用
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3, label: `记忆总结·${characterName}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content;

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // ── 归档确认制：产出草稿，不直接入库 ──
    // 计算内容指纹；命中墓碑（用户删过/拒过）则直接丢弃，避免「删了又冒出来」。
    const contentHash = computeContentHash(summary);
    if (isHashedDeleted(characterId, contentHash)) {
        console.log("[MemorySummarizer] 命中墓碑，丢弃该总结（防复活）");
        setLastSummarizedTimestamp(characterId, latest);
        resetEventCounter(characterId);
        return { success: true };
    }
    // 指纹去重：正式库已有同内容 → 不重复产出
    const existing = await loadMemoryEntries(characterId);
    const duplicated = existing.some(e => computeContentHash(e.content) === contentHash);
    if (duplicated) {
        console.log("[MemorySummarizer] 内容已存在（指纹去重），跳过");
        setLastSummarizedTimestamp(characterId, latest);
        resetEventCounter(characterId);
        return { success: true };
    }

    const draft: MemoryDraft = {
        id: `mem_draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        characterName,
        content: summary,
        sourceApp: dominantSource as MemoryDraft["sourceApp"],
        earliest,
        latest,
        summarizedEvents: allEntries.length,
        sourceSessionIds,
        embedding,
        contentHash,
        createdAt: new Date().toISOString(),
    };
    addMemoryDraft(draft);
    // 草稿已生成，推进水位线，避免同一段素材反复产出草稿
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    console.log(`[MemorySummarizer] 已产出归档草稿（${allEntries.length} 条素材），待用户确认`);
    return { success: true, draftId: draft.id };
}

/**
 * 确认归档：把草稿落库为正式长期记忆（人工确认制的唯一入库出口）。
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

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, draft.characterName || "");
    return { success: true };
}

/**
 * 丢弃草稿：进墓碑，这段内容不再被总结复活。
 */
export function discardMemoryDraft(characterId: string, draft: MemoryDraft): void {
    addDeletedHash(characterId, draft.contentHash);
    removeMemoryDraft(characterId, draft.id);
}
