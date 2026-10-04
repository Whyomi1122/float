// lib/ensemble-parser.ts
// 群像模式（Ensemble）——「帧」解析器
//
// 设计目标（第 1 项：单消息流）：
//   模型一次返回「整幕」文本（多角色 + 旁白混排），本模块把它解析成
//   EnsembleFrame[]，前端遍历帧连续渲染，角色名内联，不再一人一张卡。
//
// ── 2026-10 定稿：旁白协议 ──────────────────────────────
// 旁白不再靠「看不出是环境还是动作的圆括号」猜测，而是由模型显式打暗号：
//   行首 `[旁白]:` 或 `[旁白]：`  → 该行是旁白帧
// 解析器读到后**把 `[旁白]:` 整个 slice 掉**，只留正文，并打 kind:"narration"。
// 界面上永远不出现「旁白」两个字，用户只看到斜体灰 + 下浅虚线这一种视觉。
//
// 其它未带暗号的散行（角色名之前的段落）同样落为 narration，作为兜底，
// 保证「绝不丢字」。
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
  /** 该帧的正文（原样保留，由渲染层决定排版） */
  text: string;
  /** 帧类型：dialogue=有说话人，narration=旁白/环境，inner=心理描写 */
  kind: "dialogue" | "narration" | "inner";
};

export type EnsembleParsedReply = {
  /** 解析出的帧序列 */
  frames: EnsembleFrame[];
  /** 本条回复是否包含多个说话人（用于判断是否真正「群像」） */
  multiSpeaker: boolean;
  /** 原始文本（未经清洗，便于调试/落库 rawText） */
  rawText: string;
};

export const ENSEMBLE_PARSER_VERSION = 2;

/**
 * 旁白协议暗号：行首 `[旁白]` / `【旁白】` + 可选冒号。
 * 冒号可有可无，因为 `[旁白]` 本身已足够明确；带不带都会被完整消费。
 */
const NARRATION_TOKEN = /^\s*[\[［【]\s*旁白\s*[\]］】]\s*[:：]?\s*/;

/**
 * 心理描写协议暗号：行首 `[心理]` / `【心理】` + 可选冒号。
 * 与旁白同构：解析器读到后把暗号整个 slice 掉，只留正文，并打 kind:"inner"。
 * 渲染层据此上雾霾蓝 #93A9D1 —— 这是「心理」与「动作/环境」唯一的分野。
 */
const INNER_TOKEN = /^\s*[\[［【]\s*心理\s*[\]］】]\s*[:：]?\s*/;

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
 *
 * ⚠️ 方括号唯一认领格式**必须带冒号**：`[角色名]:` / `[角色名]：`。
 *    这样 `[旁白]`（不带冒号）不会被误当成一个叫「旁白」的角色，
 *    而是在上方 NARRATION_TOKEN 处被显式消费。
 */
/**
 * 说明：这里**不再做通用「任意短词 + 冒号」认领**。
 *
 * 2026-10 修复（首次实机验收暴露的问题）：
 *   旧实现的兜底正则 `([^\s:：""（(【\[]{1,12})\s*[:：]` 会把**任何**
 *   带冒号的短句都当成说话人。实机里模型写的是「跑了一路，到这儿腿还没软。」
 *   这类半角逗号 + 冒号混排的叙述，被误判为角色名 → 于是整幕切碎、全部
 *   走 dialogue 分支，正文里再没有 narration 帧，视觉上却因数据侧兜底
 *   统一显示成旁白样式，就是「全部变斜体灰、头像名字消失」的根因。
 *
 *   新策略：**白名单认领**。只认两种行首标记，其余一律视为普通正文：
 *     ① `[角色名]:` / `【角色名】:`（方括号包裹，必须带冒号）
 *     ② `角色名：`（必须用**全角冒号**，且名字必须命中演员表）
 *   冒号必须是全角，是为了把「跑了一路，到这儿腿还没软。」这类半角冒号
 *   叙述排除在外 —— 中文写作里人名署名几乎不会用半角冒号。
 */
function matchSpeakerPrefix(line: string): { name: string; rest: string } | null {
  // ① 方括号格式 [角色名]: / 【角色名】：/ ［角色名］：—— 预设和模型输出常用此格式
  //    ⚠️ 必须同时吃半角 []、全角 ［］、中文 【】，因为提示词里写的是全角 ［］
  //       （半角 [ ] 在 JS 模板字符串里会被当成数组字面量求值，方括号会被吃掉）
  const bracketM = line.match(
    /^\s*[\[［【]\s*([^\[\]［］【】]{1,12}?)\s*[\]］】]\s*[:：]\s*(.*)$/
  );
  if (bracketM) {
    const bName = bracketM[1].trim();
    if (bName) {
      let bRest = (bracketM[2] || "").trim();
      bRest = bRest.replace(/[*#>]+\s*$/, "").trim();
      return { name: bName, rest: bRest };
    }
  }
  // ② 通用格式：全角书名号/装饰符包裹 + 角色名 + **全角冒号**
  const m = line.match(
    /^\s*(?:[*#>]{1,3}\s*)?(?:\d+[.、)]\s*)?\*{0,2}\s*([^\s:：""（(【\[［\]］]{1,12})\s*：\s*(.*)$/
  );
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  // 名字里再排除「明显是句子」的情况：含逗号/句号/问号等标点的，肯定不是人名
  if (/[，。！？；、,.!?;]/.test(name)) return null;
  // 行首装饰符（**、#、>）在冒号后常以「**」形式收尾，需一并剥掉，
  // 否则会残留在帧正文开头（如 "** ⏎ （靠在门框上）"）。
  let rest = (m[2] || "").trim();
  // 尾部连续的装饰符（收尾的 ** / ## / >>），不吞正文里的普通标点
  rest = rest.replace(/[*#>]+\s*$/, "").trim();
  return { name, rest };
}

/**
 * 在演员表里按名字找人（精确优先 → 前缀模糊 → 全员表兜底）。
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
 * 规则（2026-10 定稿）：
 *   1. 行首 `[旁白]`（可带冒号）→ 显式旁白帧，暗号本身被 slice 掉，
 *      不进入正文；该行起的连续非空行都并入这一旁白帧，直到遇到
 *      下一个 `[旁白]` 或「角色名：」。
 *   2. 行首「角色名：」（在演员表里能认领）→ 开一个 dialogue 帧，
 *      后续行归入该帧，直到下一个说话人/旁白。
 *   3. 任何角色名与 `[旁白]` 之前的散行（环境描写）→ 兜底 narration 帧。
 *   4. 整段都没认领到任何标记 → 全部作为 narration（单帧），不丢字。
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
  // 当前是否正在累积一个「显式旁白」帧（由 [旁白] 暗号开启）
  let currentNarration: string[] | null = null;
  // 当前是否正在累积一个「心理描写」帧（由 [心理] 暗号开启），
  // 冻结该帧的说话人归属：心理属于「上一个开口的角色」，不是旁白。
  let currentInner: { text: string[]; speaker?: string; speakerId?: string; speakerAvatar?: string | null } | null =
    null;
  // 角色名之前的散行，先攒着，遇到说话人时作为旁白帧 flush
  const narrationBuffer: string[] = [];
  // 首帧之前是否已出现过说话人（用于判断是否真正「群像」）
  const speakersSeen = new Set<string>();
  // 幕首的散行（尚未出现任何角色）：暂存，等第一个角色出现后并进他的帧
  const pendingHead: string[] = [];

  const flushNarration = () => {
    const t = narrationBuffer.join("\n").trim();
    if (t) {
      // 无归属散行 → 旁白帧（渲染层负责斜体灰样式）。
      frames.push({ text: t, kind: "narration" });
    }
    narrationBuffer.length = 0;
  };

  /** 落地下一个 [旁白] 块。 */
  const flushExplicitNarration = () => {
    if (currentNarration) {
      const t = currentNarration.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) frames.push({ text: t, kind: "narration" });
    }
    currentNarration = null;
  };

  /** 落地下一个 [心理] 块。心理归属上一个开口的角色（若还没有则无归属）。 */
  const flushInner = () => {
    if (currentInner) {
      const t = currentInner.text.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) {
        frames.push({
          text: t,
          kind: "inner",
          speaker: currentInner.speaker,
          speakerId: currentInner.speakerId,
          speakerAvatar: currentInner.speakerAvatar,
        });
      }
    }
    currentInner = null;
  };

  const flushCurrent = () => {
    if (current) {
      current.text = current.text.replace(/\n+$/, "").trim();
      if (current.text) {
        frames.push(current);
      }
    }
    current = null;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // ── ① 显式旁白暗号 [旁白] ──
    if (NARRATION_TOKEN.test(line)) {
      const rest = line.replace(NARRATION_TOKEN, "").trim();
      flushNarration();
      flushCurrent();
      flushExplicitNarration();
      flushInner();
      currentNarration = rest ? [rest] : [];
      continue;
    }

    // ── ①b 显式心理暗号 [心理]（与旁白同构，归属上一个开口的角色）──
    if (INNER_TOKEN.test(line)) {
      const rest = line.replace(INNER_TOKEN, "").trim();
      flushNarration();
      flushExplicitNarration();
      flushInner();
      // 冻结归属：心理属于「在此之前最后开口的那个角色」
      const owner = current;
      flushCurrent();
      currentInner = {
        text: rest ? [rest] : [],
        speaker: owner?.speaker,
        speakerId: owner?.speakerId,
        speakerAvatar: owner?.speakerAvatar,
      };
      continue;
    }

    const hit = matchSpeakerPrefix(line);

    if (hit) {
      const member = findCastMember(hit.name, actors, allCast);
      // 认领成功 → 换帧
      if (member) {
        flushNarration();
        flushExplicitNarration();
        flushInner();
        flushCurrent();
        speakersSeen.add(member.name);
        // 幕首无归属散行：关闭旁白时归给这第一个出场的角色，别丢字
        const headPrefix = pendingHead.splice(0).join("\n").trim();
        current = {
          speaker: member.name,
          speakerId: member.id,
          speakerAvatar: member.avatar ?? null,
          text: headPrefix
            ? headPrefix + (hit.rest ? `\n${hit.rest}` : "")
            : hit.rest,
          kind: "dialogue",
        };
        continue;
      }
      // 认不出的人名 → 不当作说话人，当作普通正文
    }

    // ── ② 显式旁白块累积中：所有行先归它 ──
    if (currentNarration) {
      currentNarration.push(line);
      continue;
    }

    // ── ②b 显式心理块累积中：所有行先归它 ──
    if (currentInner) {
      currentInner.text.push(line);
      continue;
    }

    // ── ③ 未开场散行：攒进 pendingHead（若还没出现任何角色）──
    if (!current) {
      if (speakersSeen.size === 0) {
        pendingHead.push(line);
      }
      narrationBuffer.push(line);
      continue;
    }

    // ── ④ 普通行：追加到当前说话人 ──
    const chunk = line.trim();
    if (!chunk) {
      // 空行：仅在后面还有内容时保留为一个分隔（避免帧尾挂空行）
      if (current.text && !current.text.endsWith("\n")) current.text += "\n";
      continue;
    }
    current.text = current.text ? `${current.text}\n${chunk}` : chunk;
  }

  flushNarration();
  flushExplicitNarration();
  flushInner();
  flushCurrent();

  // 兜底：整段都没解析出帧 → 全作为一帧，绝不静默丢稿。
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
