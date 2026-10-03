// lib/ensemble-parser.ts
// 群像模式（Ensemble）——「帧」解析器
//
// 设计目标（第 1 项：单消息流）：
//   模型一次返回「整幕」文本（多角色 + 旁白混排），本模块把它解析成
//   EnsembleFrame[]，前端遍历帧连续渲染，角色名内联，不再一人一张卡。
//
// 帧模型参考了 vn-parser 的骨架（think 剥离 → 主体提取 → 逐行切帧 → 兜底），
// 但标记体系换成本项目的中文三色规范：
//   （动作/环境） / "台词" / 【内心独白】 / 角色名： 起头
//
// ⚠️ 纯函数、无副作用，不 import 任何 UI，方便单测与在组件外调用。

import type { EnsembleCastMember } from "./ensemble-storage";

/** 一帧 = 一个「说话单元」。speaker 为空代表旁白/环境描写。 */
export type EnsembleFrame = {
  /** 说话人显示名；缺省 = 旁白（无归属） */
  speaker?: string;
  /** 命中的角色 id（若在演员表里找到） */
  speakerId?: string;
  /** 说话人头像（命中演员表时带上） */
  speakerAvatar?: string | null;
  /** 该帧的正文（保留三色标记原样，交给 TriColorText 渲染） */
  text: string;
  /** 帧类型：dialogue=有说话人，narration=旁白/环境 */
  kind: "dialogue" | "narration";
};

export type EnsembleParsedReply = {
  /** 解析出的帧序列 */
  frames: EnsembleFrame[];
  /** 本条回复是否包含多个说话人（用于判断是否真正「群像」） */
  multiSpeaker: boolean;
  /** 原始文本（未经清洗，便于调试/落库 rawText） */
  rawText: string;
};

export const ENSEMBLE_PARSER_VERSION = 1;

/**
 * 剥离模型推理泄漏块（<think>/<thinking>），并提取 <content> 主体。
 * 与 vn-parser 同策略：有些模型会把 CoT 混进正文，必须先清掉。
 */
function stripReasoningAndExtract(text: string): string {
  let out = text.trim();
  // 1) 去掉 think / thinking 块
  out = out.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
  // 2) 若模型用 <content> 包了正文，只取其中
  const m = out.match(/<content>([\s\S]*?)<\/content>/i);
  if (m) out = m[1].trim();
  return out;
}

/**
 * 把一行「角色名：」的行首识别出来。
 * 兼容：行首空格、** / # / > / - 装饰、有序号、全角/半角冒号、书名号包裹。
 * 返回 { name, rest }，未命中返回 null。
 */
function matchSpeakerPrefix(line: string): { name: string; rest: string } | null {
  // 与 splitActorReply 保持一致的宽松度，但更克制：只在「行首」认领
  const m = line.match(
    /^\s*(?:[*#>\u3010]{1,3}\s*)?(?:\d+[.、)]\s*)?\*{0,2}\s*([^\s:："“（(【\[]{1,12})\s*[:：]\s*(.*)$/
  );
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  // 行首装饰符（**、#、>）在冒号后常以「**」形式收尾，需一并剥掉，
  // 否则会残留在帧正文开头（如 "** ⏎ （靠在门框上）"）。
  let rest = (m[2] || "").trim();
  // 尾部连续的装饰符（收尾的 ** / ## / >>），不吞正文里的普通标点
  rest = rest.replace(/[*#>]+\s*$/, "").trim();
  return { name, rest };
}

/**
 * 在演员表里按名字找人（精确优先 → 前缀模糊 → 全员表兜底）。
 * 与 splitActorReply 的 findByName 同语义，保证行为一致。
 */
function findCastMember(
  raw: string,
  actors: EnsembleCastMember[],
  allCast: EnsembleCastMember[]
): EnsembleCastMember | undefined {
  const n = raw.trim().replace(/^[-*#>\s]+|[-*#\s:：]+$/g, "");
  if (!n) return undefined;
  return (
    actors.find((a) => a.name === n) ||
    actors.find((a) => n.startsWith(a.name) || a.name.startsWith(n)) ||
    allCast.find((a) => a.name === n)
  );
}

/**
 * 解析整幕回复 → 帧序列。
 *
 * 规则：
 *   1. 行首「角色名：」→ 开一个新的 dialogue 帧，后续行归入该帧，
 *      直到遇到下一个「角色名：」（而不是像旧 splitActorReply 那样只切幕）。
 *   2. 任何角色名之前的散行（环境描写/旁白）→ narration 帧。
 *   3. 整段都没认领到角色名 → 全部作为 narration（单帧），不丢字。
 *
 * @param text    模型原始回复
 * @param actors  本幕候选演员（通常传全员）
 * @param allCast 全员名单（兜底认领）
 */
export function parseEnsembleReply(
  text: string,
  actors: EnsembleCastMember[] = [],
  allCast: EnsembleCastMember[] = actors
): EnsembleParsedReply {
  const rawText = text ?? "";
  const body = stripReasoningAndExtract(rawText);

  if (!body) {
    return { frames: [], multiSpeaker: false, rawText };
  }

  const lines = body.split(/\r?\n/);
  const frames: EnsembleFrame[] = [];

  // 当前正在累积的帧（有 speaker 才 push）
  let current: EnsembleFrame | null = null;
  // 角色名之前的散行，先攒着，遇到说话人时作为旁白帧 flush
  const narrationBuffer: string[] = [];
  // 首帧之前是否已出现过说话人（用于决定旁白帧插在哪）
  const speakersSeen = new Set<string>();

  const flushNarration = () => {
    const t = narrationBuffer.join("\n").trim();
    if (t) frames.push({ text: t, kind: "narration" });
    narrationBuffer.length = 0;
  };

  const flushCurrent = () => {
    if (current) {
      current.text = current.text.replace(/\n+$/, "").trim();
      if (current.text) frames.push(current);
    }
    current = null;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const hit = matchSpeakerPrefix(line);

    if (hit) {
      const member = findCastMember(hit.name, actors, allCast);
      // 认领成功 → 换帧（或仍然认领给同一人但没换行时继续累积）
      if (member) {
        // 旁白缓冲先落地（它属于这一帧之前的环境）
        flushNarration();
        flushCurrent();
        speakersSeen.add(member.name);
        current = {
          speaker: member.name,
          speakerId: member.id,
          speakerAvatar: member.avatar ?? null,
          text: hit.rest,
          kind: "dialogue",
        };
        continue;
      }
      // 认认不出的人名 → 不当年说话人，当作普通正文
    }

    // ── 旁白提升（段落级）──
    // 中文三色体系下，「（整行圆括号包裹）」既可能是角色动作，
    // 也可能是环境镜头，仅靠文本无法区分。这里用最强的判据：
    //   当前行整行是一个圆括号段 + 它处于段落起始（前一行是空行 / 是首行）
    //   + 已经有正在进行的角色帧 → 判为独立旁白帧。
    // 这样能救回"说完台词后另起一段的环境描写"，又不会误切
    // 角色台词内部紧跟的（动作）（因为那种情况前一行不是空行）。
    const isBlankPrev = li === 0 || lines[li - 1].trim() === "";
    const wholeParen = /^\s*[（(][\s\S]*[）)]\s*$/.test(line);
    if (current && isBlankPrev && wholeParen) {
      flushNarration();
      flushCurrent();
      narrationBuffer.push(line);
      continue;
    }

    // 普通行：追加到当前说话人或旁白缓冲
    if (current) {
      const chunk = line.trim();
      if (!chunk) {
        // 空行：仅在后面还有内容时保留为一个分隔（避免帧尾挂空行）
        if (current.text && !current.text.endsWith("\n")) current.text += "\n";
        continue;
      }
      current.text = current.text ? `${current.text}\n${chunk}` : chunk;
    } else {
      narrationBuffer.push(line);
    }
  }

  flushNarration();
  flushCurrent();

  // 兜底：整段都没解析出帧 → 全作为旁白，绝不静默丢稿
  if (frames.length === 0 && body) {
    frames.push({ text: body, kind: "narration" });
  }

  return {
    frames,
    multiSpeaker: speakersSeen.size > 1,
    rawText,
  };
}

/**
 * 兼容旧调用：把帧序列再「聚回」切幕结构（每人一幕），
 * 供尚未迁移到帧渲染的代码路径（如落库为 EnsembleTurn[]）使用。
 *
 * ⚠️ 这是过渡期桥接函数：一旦渲染层全面改为帧模型即可删除。
 */
export function framesToActorSlices(
  frames: EnsembleFrame[]
): { name: string; speakerId?: string; content: string }[] {
  const out: { name: string; speakerId?: string; content: string }[] = [];
  for (const f of frames) {
    const name = f.speaker ?? "\u65c1\u767d";
    const last = out[out.length - 1];
    if (last && last.name === name) {
      last.content = last.content ? `${last.content}\n${f.text}` : f.text;
    } else {
      out.push({ name, speakerId: f.speakerId, content: f.text });
    }
  }
  return out.filter((s) => s.content.trim().length > 0);
}
