/**
 * 群像记忆注入引擎（2026-10-09 新建 · M1）
 * ──────────────────────────────────────────────────────────────
 * 背景：float 自带完整记忆系统（`memory-*` 五模块），单聊/共创等五大引擎均已接入，
 *       唯独群像从未接入。本文件负责把「按角色存储的记忆」注入群像提示词。
 *
 * 用户口径（2026-10-09 拍板）：
 *   ① 取谁的记忆？ → **全员并标注归属**（每个在场角色都取，注入时标明属于谁）
 *   ② "线上互通"通到哪？ → **读单聊里跟同一角色的记忆**（同一个 characterId）
 *   ③ 记忆从哪来？ → **沿用单聊已有的记忆库（共用一套）**
 *
 * 关键事实：`EnsembleCastMember.id` 就是真实 `characterId`
 *   （建剧本时 `cast: chosenChars.map(c => ({ id: c.id, ... }))`），
 *   因此可以直接拿 cast.id 调 `retrieveMemoriesForPrompt(characterId, ...)`，
 *   天然实现"读同一角色在单聊的记忆"。
 *
 * 与单聊的差异：单聊只有 1 个角色，群像有 N 个。
 *   → 逐角色检索，然后**按角色分段标注**拼装，而不是简单堆在一起。
 */

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import {
  retrieveMemoriesForPrompt,
  retrieveCoreMemoriesForPrompt,
} from "./memory-service";
import { loadMemoryConfig } from "./memory-storage";

/** 一个角色的记忆检索结果。 */
export type RoleMemoryBlock = {
  characterId: string;
  name: string;
  longTerm: MemoryEntry[];
  core: MemoryEntry[];
};

/** 群像记忆注入结果。 */
export type EnsembleMemoryResult = {
  /** 已格式化的注入文本；无任何记忆时为空串。 */
  text: string;
  /** 逐角色的检索明细（调试用）。 */
  blocks: RoleMemoryBlock[];
  /** 参与检索的角色数。 */
  roleCount: number;
  /** 命中的记忆总条数。 */
  totalCount: number;
};

/** 单条记忆 → 文本行。与 `formatLongTermMemories` 口径一致（`- 内容`）。 */
function formatEntries(entries: MemoryEntry[]): string[] {
  return entries.map((e) => `- ${(e.content ?? "").trim()}`).filter((l) => l.length > 2);
}

/**
 * 为群像剧本检索并格式化记忆。
 *
 * @param cast 剧本演员表（`EnsembleScript.cast`）。注意 id 即真实 characterId。
 * @param contextText 检索上下文（本幕最近若干回合正文），用于向量相似度排序。
 * @param options.enabled 「线上互通」开关。false 时直接返回空（不检索、不注入）。
 * @param options.limitPerRole 每角色最多注入的长期记忆条数（默认不限，交给 tokenBudget）。
 * @returns 格式化文本 + 明细。
 */
export async function buildEnsembleMemoryBlock(
  cast: { id: string; name: string }[],
  contextText: string,
  options?: { enabled?: boolean; limitPerRole?: number }
): Promise<EnsembleMemoryResult> {
  const enabled = options?.enabled ?? false;
  if (!enabled || !cast || cast.length === 0) {
    return { text: "", blocks: [], roleCount: 0, totalCount: 0 };
  }

  const config: MemoryConfig = loadMemoryConfig();
  const limitPerRole = options?.limitPerRole ?? 0;

  // 逐角色并行检索（长期 + 核心）。任一角色出错不影响其他角色。
  const blocks = await Promise.all(
    cast.map(async (member): Promise<RoleMemoryBlock> => {
      const [longTerm, core] = await Promise.all([
        retrieveMemoriesForPrompt(member.id, contextText, config).catch(() => []),
        retrieveCoreMemoriesForPrompt(member.id, config).catch(() => []),
      ]);
      return {
        characterId: member.id,
        name: member.name,
        longTerm: limitPerRole > 0 ? longTerm.slice(0, limitPerRole) : longTerm,
        core,
      };
    })
  );

  // 过滤掉没有记忆的角色
  const withMemory = blocks.filter((b) => b.longTerm.length > 0 || b.core.length > 0);
  const totalCount = withMemory.reduce((n, b) => n + b.longTerm.length + b.core.length, 0);

  if (withMemory.length === 0) {
    return { text: "", blocks: [], roleCount: 0, totalCount: 0 };
  }

  // 按角色分段标注归属（用户口径 ①：全员并标注归属）
  const sections: string[] = [];
  for (const b of withMemory) {
    const lines: string[] = [];
    const coreLines = formatEntries(b.core);
    const longLines = formatEntries(b.longTerm);
    if (coreLines.length > 0) {
      lines.push(`【核心记忆】`);
      lines.push(...coreLines);
    }
    if (longLines.length > 0) {
      lines.push(`【相关记忆】`);
      lines.push(...longLines);
    }
    if (lines.length > 0) {
      sections.push(`◆ ${b.name}\n${lines.join("\n")}`);
    }
  }

  const text = `
═══════════ 线上记忆 · 互通库（这些是你离线/单聊时的记忆，可在剧情中自然调用）═══════════
${sections.join("\n\n")}
`;
  return {
    text,
    blocks: withBlocksClean(withMemory),
    roleCount: withMemory.length,
    totalCount,
  };
}

/** 内部：把 blocks 收敛为最终对外结构（去掉空块）。 */
function withBlocksClean(blocks: RoleMemoryBlock[]): RoleMemoryBlock[] {
  return blocks.filter((b) => b.longTerm.length > 0 || b.core.length > 0);
}
