// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}

/**
 * 归档：人工确认的长档案，权重等同世界书。
 * 以「以下为已确认的过往事实，具有最高可信度」的强约束形式输出。
 */
export function formatArchives(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    const blocks: string[] = [];
    for (const entry of memories) {
        const when = String((entry.metadata?.archivedAt as string) || entry.createdAt || "").slice(0, 10);
        blocks.push(`【归档 · ${when}】\n${entry.content}`);
    }
    return blocks.join("\n\n");
}
