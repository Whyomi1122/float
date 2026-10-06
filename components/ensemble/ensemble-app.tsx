"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Send,
  Trash2,
  Users,
  Compass,
  Check,
  RefreshCw,
  Pencil,
  Layers,
  Wrench,
  Eye,
  Settings,
  Clock,
  MessageSquare,
  Eraser,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import {
  resolveUserIdentity,
  loadUserIdentities,
  loadBindingConfig,
  resolveBinding,
  loadApiConfigs,
} from "@/lib/settings-storage";
import type { ApiConfig } from "@/lib/settings-types";
import { simpleLLMCall } from "@/lib/api-helpers";
import { fetchModelNames } from "@/lib/model-list";
import {
  EnsembleToolsSheet,
  type EnsembleToolId,
} from "@/components/ensemble/ensemble-tools-sheet";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
  EnsembleScript,
  EnsembleTurn,
  EnsembleCastMember,
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  appendEnsembleTurn,
  deleteEnsembleTurn,
  updateEnsembleTurn,
} from "@/lib/ensemble-storage";
import {
  parseEnsembleReply,
  type EnsembleFrame,
  type EnsembleStatusEntry,
} from "@/lib/ensemble-parser";
import {
  resolveStoryTime,
  buildTimeAwarenessBlock,
  buildStatusContractBlock,
} from "@/lib/ensemble-time";
import {
  EnsembleStatusCardLayer,
  DEFAULT_STATUS_TEMPLATE,
  DEFAULT_STATUS_FIELDS,
} from "@/components/ensemble/ensemble-status-card";
import {
  StatusFieldEditor,
  StatusTemplateEditor,
  StatusToggleRow,
  StatusSectionHead,
  StatusFieldActions,
  type StatusField,
} from "@/components/ensemble/ensemble-status-sheet";

// ══════════════════════════════════════════════════════════
// API 绑定桥（Ensemble ↔ 全局设置里的 API 配置）
// 走项目标准链路：loadBindingConfig → resolveBinding → loadApiConfigs
// appId 使用 "ensemble"（已注册进 ContentAppId），可在
// 「设置 → 绑定」里为群像单独指定 API，未指定则继承全局默认。
// ══════════════════════════════════════════════════════════

// 字号策略（2026-10 定稿）：群像内部字号**写死**，不跟随全局 --app-text-scale。
// 此前群像走 ts() 跟随全局缩放，导致「设置 → 主题 → 文字缩放」会连带放大
// 群像内部排版，把设计稿的节奏（正文/名字/旁白的层级差）整个破坏掉。
// 现在所有字号一律固定 px，与《功能》面板的 fs() 同一套约定。
function tpx(px: number): string {
  return `${px}px`;
}

const ENSEMBLE_APP_ID = "ensemble";

/**
 * 解析群像模式要用的 API 配置。
 * 级联优先级：剧本级覆盖 → 全局默认 → 角色默认 → 群像 app 覆盖 → 角色在群像上的覆盖。
 * 兜底：若级联结果为空（例如用户清空了全局默认），退到第一条 API 配置。
 *
 * modelOverride：剧本级模型覆盖。命中时把 defaultModel 换成它，
 * 但**不改动全局设置里的那条 API 配置**（返回的是浅拷贝）。
 */
export function resolveEnsembleApiConfig(
  characterId?: string,
  scriptOverrideId?: string,
  modelOverride?: string
): ApiConfig | null {
  const configs = loadApiConfigs();
  if (configs.length === 0) return null;

  /** 把剧本级模型覆盖叠加上去（只改返回值，不写回存储） */
  const withModel = (cfg: ApiConfig): ApiConfig =>
    modelOverride?.trim()
      ? { ...cfg, defaultModel: modelOverride.trim() }
      : cfg;

  // 剧本级覆盖优先级最高：用户在「功能 → 模型切换」里显式指定的那条
  if (scriptOverrideId) {
    const overridden = configs.find((c) => c.id === scriptOverrideId);
    if (overridden) return withModel(overridden);
  }
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, ENSEMBLE_APP_ID);
    if (slot.apiConfigId) {
      const found = configs.find((c) => c.id === slot.apiConfigId);
      if (found) return withModel(found);
    }
  } catch (e) {
    console.warn("[ensemble] resolveEnsembleApiConfig failed:", e);
  }
  return withModel(configs[0]);
}

/** 供 UI 显示用的模型名（真实取自全局设置里选中的那条 API 配置） */
export function ensembleModelLabel(characterId?: string): string {
  const cfg = resolveEnsembleApiConfig(characterId);
  if (!cfg) return "未配置 API";
  return cfg.defaultModel || cfg.name || cfg.provider || "未知模型";
}

// ──────────────────────────────────────────────────────────────
// 排版常量（2026-10 定稿，全部写死）
// 配色体系（用户定稿）：
//   · 对话（韩语原文 / 中文翻译）→ 黑色 C_DIALOG
//   · 心理描写（［心理］暗号）     → **与叙述完全一致**（1005 反馈：心理太明显，并入叙述）
//   · 叙述/动作                   → 灰 #8e8e93（1005 反馈：加深）
//   · 旁白                        → 更淡的灰 #b4b4b8 + 斜体（1005 反馈：与正文灰对调）
// 长文可读性优化（第5轮定稿）：层级靠**字号 + 灰度 + 段距**三重拉开。
//   核心原则：对白往前（重）· 叙述居中（灰）· 旁白最轻（淡灰斜体）。
// ──────────────────────────────────────────────────────────────
const T_DIALOG = 14; // 对白（1005 反馈：15 → 14）
const T_ACT = 13.5; // 叙述/动作：略小于对白，退为背景
const T_INNER = 13.5; // 心理：与叙述完全一致（1005 反馈）
const C_DIALOG = "#1f1f1f"; // 对话：黑
const C_INNER = "#8e8e93"; // 心理：与叙述同色（1005 反馈：取消蓝色）
const C_ACT = "#8e8e93"; // 叙述/动作：灰（1005 反馈：加深，#b4b4b8 → #8e8e93）
const T_NAME = 12.5; // 角色名（第5轮：11.5 → 12.5，锚点更清晰）
const C_NAME = "#5a5a5e"; // 角色名：加深（原 #8a8a8e 太浅，认不出人）
const T_NARR = 13; // 旁白：比正文小 1px
const C_NARR = "#b4b4b8"; // 旁白：更淡的灰（1005 反馈：与正文灰对调）
// 旁白「真实生效」的视觉权重（1005 二次反馈修正）：
//   曾出现「常量已改成 #b4b4b8，实机仍比正文深」——最可能是被剧本级 customCss
//   覆盖（注入的 <style> 全文档生效且权重更高）。此处把旁白样式改为行内
//   style 直接输出，行内优先级最高，任何外部 CSS 都无法再盖掉它。
function narrStyle(): React.CSSProperties {
  return {
    fontSize: tpx(T_NARR),
    color: C_NARR,
    fontWeight: 400,
    lineHeight: 1.9,
    opacity: 1,
    fontStyle: "italic",
  };
}
/** 头像尺寸（定稿 35px，此前 78px 过大被用户吐槽「像生图来了」） */
const AVATAR_PX = 35;
// 段距（长文排版定稿）：
// 1006 反馈（第6轮）：对白段距 11 → 10（收紧）；旁白间距 26 → 14（不再大喘气）。
const GAP_DIALOG = 10; // 对白段之间（1006：11 → 10）
const GAP_ACT = 7; // 叙述/动作段之间（更紧，成组）
const GAP_INNER = GAP_ACT; // 心理块上下：与叙述一致（1005 反馈）
const GAP_NARR = 14; // 旁白上下（1006：26 → 14，原间距过大）
const GAP_BLOCK = 20; // 角色块之间（换人）（1006：26 → 20，随整体收紧）

// ── 帧级左右内缩（1006 第6轮定稿）──
// 用户口径：① 所有帧整体左右内缩（原来铺得太宽）② 左右必须**严格对称**，
// 不能左缩右不缩（否则整块看着歪）。③ 正文比头像再多缩一档，形成二级层次。
// 实现：帧流外层 .ensemble-frames 左右各 FRAME_INSET；正文/头像行再各 FRAME_TEXT_INSET。
// 关键：**同时写 paddingLeft 与 paddingRight**，任何一侧都不能漏，否则又不对称。
const FRAME_INSET = 16; // 整块左右内缩
const FRAME_TEXT_INSET = 9; // 正文/头像行再内缩（合计左右各 25px）

// ── 每轮输出长度 / token 护栏（用户口径 2026-10-06 四次调整后定稿）──
// 设计要点：**提示词管「别写太多」，maxTokens 闸门管「别写太长」**，两者叠加。
//   - 提示词里的 N  → 模型自觉「写 N 字左右」（所以不会涨到 2000 字）
//   - maxTokens     → 服务器强制闸门（所以不会无限长）
// 因此护栏**不需要很大余量**，只需留一口气让模型把最后一句收完。
// 若 M 严格 = N，模型想写 N+20 字就会被闸门劈成半句 —— 这才是真正的风险。
// 用户定稿：M = N + 200（留一口气收尾，token 数字也不夸张）。
const CHARS_MIN = 50;
const CHARS_MAX = 5000; // 目标值上限
const CHARS_TO_TOKENS = 1.6;
const TOKEN_HEADROOM = 1;
/** 收尾余量：给模型留出把最后一句写完的额度，不参与「目标字数」提示。 */
const CHARS_TAIL_MARGIN = 200;

/** 由目标字数 N 求实际允许的字数上限 M。用户定稿：M = N + 200。 */
function targetCharsToMaxChars(n: number): number {
  return Math.round(n) + CHARS_TAIL_MARGIN;
}

/** 由目标字数 N 求请求用的 maxOutputTokens（1 字 ≈ 1.6 token）。 */
function charsToMaxTokens(chars: number): number {
  return Math.ceil(targetCharsToMaxChars(chars) * CHARS_TO_TOKENS * TOKEN_HEADROOM);
}

// ── 架空起点（W1 第二版 · 手动文本输入）──
// 用户：「时间输入的时候可以规定一下格式 ai 好识别」。
// 规定格式 YYYY-MM-DD HH:mm（24 小时制），但解析时**容忍常见写法**，
// 免得用户少写个 0、用 "/" 或 "." 分隔就存不进去。
// 支持：2015-03-29 15:54 / 2015/3/29 15:54 / 2015.03.29 15:54 / 2015-03-29T15:54

/** 把用户手填的起点字符串规整成 ISO 形式；无法识别返回 null。 */
function normalizeTimeAnchor(raw: string): string | null {
  const s = (raw || "").trim().replace(/[年月]/g, "-").replace(/日/g, " ").replace(/[\/.]/g, "-");
  const m = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const M = Number(mo);
  const D = Number(d);
  const H = Number(h);
  const MI = Number(mi);
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59) return null;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${y}-${pad(M)}-${pad(D)}T${pad(H)}:${pad(MI)}`;
}

/** 起点格式是否可识别（用于输入框下方的即时校验提示）。 */
function isValidTimeAnchor(raw: string): boolean {
  return normalizeTimeAnchor(raw) !== null;
}

/**
 * 正文排版组件（长文可读性版）。
 *
 *   · 对白（dialogue 帧）→ 黑 #1f1f1f，15px（主角）
 *   · 叙述/动作（action 帧）→ 淡灰 #b4b4b8，13.5px（退为背景）
 *   · 心理（inner 帧）→ 石板蓝 #536878，14px（不加斜体，只靠颜色）
 *   · 旁白（narration 帧）→ 灰 #8e8e93，13px + 斜体（换场呼吸点）
 *   · 不再 stripSymbols —— 隐藏符号会让「模型违规」永远看不见。
 *   · 括号规则：无条件剥除包裹整行的 （）（包括双语译文行）。
 *   · 段距按 kind 区分，见 GAP_* 常量。
 */

function BodyText({
  raw,
  kind = "act",
}: {
  raw: string;
  kind?: "dialogue" | "inner" | "act";
}) {
  const paras = (raw ?? "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (paras.length === 0) return null;
  const color =
    kind === "dialogue" ? C_DIALOG : kind === "inner" ? C_INNER : C_ACT;
  const size =
    kind === "dialogue" ? T_DIALOG : kind === "inner" ? T_INNER : T_ACT;
  // 行内直出（而非只靠 class）：防止剧本级 customCss 用更高权重覆盖配色/字号
  const headStyle: React.CSSProperties = {
    color,
    fontSize: tpx(size),
    fontWeight: 400,
    lineHeight: 1.75,
    opacity: 1,
    // 帧级内缩（1006 第6轮）：正文比头像再多缩一档；
    // 左右**同时**给，保证严格对称（右端不再顶边）。
    paddingLeft: tpx(FRAME_TEXT_INSET),
    paddingRight: tpx(FRAME_TEXT_INSET),
  };
  // 段内段距：对白/心理宽松些，叙述紧凑些（成组感）
  // 1006：对白 +5 → +2（收紧，但仍略大于正文段距）
  const inner = kind === "act" ? GAP_ACT + 3 : GAP_DIALOG + 0;
  // 括号规则（用户定稿 2026-10-04 第5轮）：**无条件剥除**包裹整行的 （），
  // 包括双语译文行。韩语对白的下一行直接写中文，不再用括号包裹。
  return (
    <div
      className={`frame-body frame-${kind} tracking-[0.01em]`}
      style={headStyle}
    >
      {paras.map((p, i) => {
        const shown = /^[（(][\s\S]*[）)]$/.test(p)
          ? p.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "")
          : p;
        return (
          <div
            key={i}
            className="whitespace-pre-wrap"
            style={{ ...headStyle, marginTop: i === 0 ? 0 : inner }}
          >
            {shown}
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 帧解析缓存：同一 (content, 演员表) 只解析一次。
// 渲染经常重跑（编辑、切换版本、滚动重排），缓存可避免反复跑正则。
// 时间戳格式化：框底 DATE 需要精确到分钟（2026-10 起，此前只显示到日）。
// 兼容 ISO 字符串与毫秒数；解析失败时退回原串前 16 位，绝不显示 Invalid Date。
function formatMinute(ts: string | number | undefined): string {
  if (ts === undefined || ts === null || ts === "") return "——";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

const __frameCache = new Map<string, EnsembleFrame[]>();

/**
 * 把「用户 persona（面具）」注入演员表，得到一个虚拟 cast 成员。
 *
 * 为什么必须注入：剧本的 `cast` 只含**建剧本时勾选的 AI 演员**，用户 persona
 * （如「岳霖玉」）只以 `personaId` 存在剧本上，不在 cast 数组里。
 * 于是当模型以「岳霖玉：」开场时，`findCastMember` 三级兜底全部落空 →
 * member undefined → 该帧降级 narration（斜体灰、无头像、无署名），
 * 且首帧内容还会被 pendingHead 重复并进下一个角色 —— 这正是图3 的根因。
 *
 * 解决：把 persona 当作「id = persona.id、name = persona.name」的虚拟成员
 * 追加到识别用名单末尾。**只用于识别与渲染**，不回写剧本 cast（保持数据干净）。
 */
function castWithPersona(
  cast: EnsembleCastMember[],
  persona: { id?: string; name?: string; avatarUrl?: string } | null | undefined
): EnsembleCastMember[] {
  if (!persona?.name) return cast;
  const pid = persona.id ?? `persona:${persona.name}`;
  if (cast.some((c) => c.id === pid || c.name === persona.name)) return cast;
  return [
    ...cast,
    {
      id: pid,
      name: persona.name,
      avatar: persona.avatarUrl ?? null,
      persona: "",
    },
  ];
}

function framesOfTurn(
  turn: EnsembleTurn,
  cast: EnsembleCastMember[]
): EnsembleFrame[] {
  const key = `${cast.map((c) => c.id).join(",")}|${turn.content}`;
  const hit = __frameCache.get(key);
  if (hit) return hit;
  const frames = parseEnsembleReply(turn.content, cast, cast).frames;
  // 简单容量控制：超过 200 条清一次，避免无限增长
  if (__frameCache.size > 200) __frameCache.clear();
  __frameCache.set(key, frames);
  return frames;
}

// 帧渲染（单消息流）──
// 一个消息流里连续渲染整幕的每一帧：
//   · narration 帧 → 旁白段：整段斜体灰 + 下浅虚线，上下各留 24px
//   · dialogue 帧 → 角色块：方角虚线框头像 + 角色名（名字在头像右侧），正文紧随
// 相邻同一说话人的帧自动并组，避免重复署名。
function EnsembleFrameStream({
  frames,
  cast,
  onAvatarClick,
}: {
  frames: EnsembleFrame[];
  cast: EnsembleCastMember[];
  /** 点头像 → 打开该幕的状态卡（未启用状态面板时由上层忽略） */
  onAvatarClick?: (speaker: string) => void;
}) {
  let lastSpeaker: string | undefined = "\u0000"; // 哨兵：保证首帧必署名
  // 跟踪上一帧是否为旁白，用于给旁白加「上下各 ≥ 一整行」的大段距。
  let prevWasNarration = false;
  // 同一角色的连续帧：第一帧给 16px，续帧给 16px（统一），换人才给 20px。
  let prevWasSameSpeaker = false;

  return (
    <div
      className="ensemble-frames"
      data-frame-count={frames.length}
      // 帧流外层：左右**严格对称**内缩（1006 第6轮）。
      // 关键：同时写 left 与 right，且不依赖父级 padding —— 父级一旦单边不同，
      // 光靠 left 就会出现「左缩右不缩」的歪斜（这正是上一版的 bug）。
      style={{
        paddingLeft: tpx(FRAME_INSET),
        paddingRight: tpx(FRAME_INSET),
      }}
    >
      {frames.map((f, i) => {
        // ── 旁白帧 ──
        // 2026-10 定稿：旁白由模型显式打暗号「［旁白］」触发（解析器已 slice 掉暗号），
        // 不再是靠圆括号猜出来的。
        // 1006 第6轮：**删掉下浅虚线**（用户：「旁白下方虚线删掉」），只保留间距。
        // 同时旁白也跟着整体内缩，与头像/正文共用同一条左基准 + 严格对称。
        if (f.kind === "narration") {
          prevWasNarration = true;
          prevWasSameSpeaker = false;
          return (
            <div
              key={i}
              className="frame-narration whitespace-pre-wrap"
              style={{
                ...narrStyle(),
                // 旁白间距统一走 GAP_NARR（1006：26 → 14，原间距过大）。
                // 首帧不带上方间距，避免紧贴卡片顶边。
                marginTop: i === 0 ? 0 : tpx(GAP_NARR),
                marginBottom: tpx(GAP_NARR),
                paddingLeft: tpx(FRAME_TEXT_INSET),
                paddingRight: tpx(FRAME_TEXT_INSET),
              }}
            >
              {f.text}
            </div>
          );
        }

        const member =
          (f.speakerId && cast.find((c) => c.id === f.speakerId)) ||
          (f.speaker ? cast.find((c) => c.name === f.speaker) : undefined);
        // ── 头像/名字的「块头」判定（2026-10-05 修 F1）──
        // 现象：action / inner 帧虽带 speaker，但渲染时不出头像/名字（它属于
        //   上一个开口的人）；若它抢先把 lastSpeaker 更新掉，紧跟其后的
        //   dialogue 帧就变成「同一个人」→ 也不出头像 → 整块永久丢失头像名字。
        // 修法：action / inner **不推进** lastSpeaker，让它们之后的第一个
        //   dialogue 帧仍被识别为「该角色的首帧」→ 正常出头像 + 名字。
        //   （模型习惯「先叙述后开口」，此修法正好命中。）
        const isSpeakerFrame = f.kind === "dialogue";
        const showName = isSpeakerFrame && f.speaker !== lastSpeaker;
        if (isSpeakerFrame) lastSpeaker = f.speaker;

        // 段距（长文排版定稿，第6轮 1006）：
        //   旁白之后     → 0（旁白自带 14px 下间距，不叠加）
        //   换角色       → 20px（角色块之间留呼吸）
        //   同角色续帧   → 对白 10 / 动作 7 / 心理 7
        const topMargin = prevWasNarration
          ? 0
          : showName
          ? GAP_BLOCK
          : f.kind === "dialogue"
          ? GAP_DIALOG
          : GAP_ACT;
        prevWasNarration = false;
        prevWasSameSpeaker = !showName;

        // 心理帧（1006 第6轮改版）：不再等同叙述，改为**独立静音块** ——
        // 极浅底 + 左侧一根细线 + 内缩，**不带任何「心理」小标签**（用户明确要求删标签）。
        // 与叙述仍是同一灰阶，层级只靠「块感」而非颜色，避免心理太跳。
        //
        // 几何（必须左右对称，否则整块歪）：
        //   外层 .ensemble-frames   left/right 16
        //   + .frame-inner 自己     margin left/right 9   → 块左沿落在正文基准线上
        //   + 块内 BodyText         padding left/right 9（它自带）
        //   块本身左右再各留 3px 内衬，让文字不贴到左细线上。
        if (f.kind === "inner") {
          return (
            <div
              key={i}
              className="frame-inner"
              style={{
                marginTop: showName ? GAP_BLOCK : GAP_INNER,
                marginLeft: tpx(FRAME_TEXT_INSET),
                marginRight: tpx(FRAME_TEXT_INSET),
                paddingTop: tpx(6),
                paddingBottom: tpx(6),
                // 左细线靠左内衬撑开：左右内衬都是 3px，块内文字距块边缘等宽。
                paddingLeft: tpx(3),
                paddingRight: tpx(3),
                background: "rgba(0,0,0,0.022)",
                borderLeft: "2px solid rgba(0,0,0,0.10)",
                borderRadius: "0 7px 7px 0",
              }}
            >
              <BodyText raw={f.text} kind="act" />
            </div>
          );
        }

        // 叙述/动作帧（用户定稿 2026-10-04 第5轮）：叙述性文字统一淡灰 #b4b4b8，
        // 不出头像/名字（它属于上一个开口的角色，只是换个颜色落笔）。
        if (f.kind === "action") {
          return (
            <div key={i} style={{ marginTop: showName ? GAP_BLOCK : GAP_ACT }}>
              <BodyText raw={f.text} kind="act" />
            </div>
          );
        }

        return (
          <div key={i} style={{ marginTop: topMargin }}>
            {showName && (
              <div
                className="flex items-center gap-2.5 mb-2.5"
                // 头像行与正文共用同一条左基准（1006 第6轮口径 A）：
                // 给它和 BodyText 完全一样的左右内缩，头像左沿 = 正文左沿。
                style={{
                  paddingLeft: tpx(FRAME_TEXT_INSET),
                  paddingRight: tpx(FRAME_TEXT_INSET),
                }}
              >
                {/* 方角 35px 虚线框头像（定稿：此前 78px 过大）
                    · 启用状态面板时，点头像 → 打开该角色的状态卡（用户定稿 10-06）。 */}
                <button
                  type="button"
                  onClick={
                    onAvatarClick && f.speaker
                      ? (e) => {
                          e.stopPropagation();
                          onAvatarClick(f.speaker as string);
                        }
                      : undefined
                  }
                  disabled={!onAvatarClick}
                  className={`rounded-[8px] border border-dashed border-black/20 bg-black/[0.03] overflow-hidden flex items-center justify-center shrink-0 ${
                    onAvatarClick ? "active:scale-95 transition-transform cursor-pointer" : ""
                  }`}
                  style={{ width: tpx(AVATAR_PX), height: tpx(AVATAR_PX) }}
                  title={onAvatarClick ? "查看状态" : undefined}
                >
                  {member?.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={member.avatar}
                      alt={f.speaker}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span
                      className="font-semibold text-black/35"
                      style={{ fontSize: tpx(15) }}
                    >
                      {(f.speaker ?? "?").slice(0, 1)}
                    </span>
                  )}
                </button>
                {/* 角色名：置于头像右侧，字号故意小于正文（层级靠字号而非颜色） */}
                <div
                  className="frame-name font-semibold tracking-wide"
                  style={{
                    fontSize: tpx(T_NAME),
                    color: C_NAME,
                    fontWeight: 600,
                    opacity: 1,
                  }}
                >
                  {f.speaker}
                </div>
              </div>
            )}
            <BodyText raw={f.text} kind="dialogue" />
          </div>
        );
      })}
    </div>
  );
}

// 通用底部子弹窗：与「功能」面板同一套视觉（浅灰底、圆角、居中标题）
// 返回体系（v3）：
//   · 顶栏右侧「← 返回」= 关闭本层（子面板 → 功能面板；功能面板 → 剧本界面）
//   · 同时与工作区左上角的浮层返回键并存（用户要求：内置返回与顶栏返回任选其一都能用）
//   · 底部不再放任何「返回」按钮 —— 只允许放「保存 / 应用」这类功能键
//   · onBack 仅用于同层内的次级导航（如模型二级 → 一级的「换 API」）
function MiniSheet({
  title,
  subtitle,
  onClose,
  onBack,
  backLabel = "返回",
  headerAction,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** 可选：同层内的“上一级”（如模型二级→一级）。存在时显示在右侧。 */
  onBack?: () => void;
  backLabel?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-[55] flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#f2f2f4] rounded-t-[26px] px-4 pt-6 pb-6 max-h-[88%] overflow-y-auto"
      >
        <div className="px-1.5 mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className="font-bold tracking-tight text-[#111111] leading-none"
              style={{ fontSize: "20px" }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                className="tracking-[0.2em] font-medium text-black/30 mt-2"
                style={{ fontSize: "10px" }}
              >
                {subtitle}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {headerAction}
            {onBack && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onBack}
                className="shrink-0 px-2.5 py-1.5 rounded-full bg-black/[0.06] text-black/50 active:scale-95 transition-transform"
                style={{ fontSize: "11px" }}
              >
                ← {backLabel}
              </button>
            )}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
              className="shrink-0 px-2.5 py-1.5 rounded-full bg-white text-black/45 active:scale-95 transition-transform"
              style={{ fontSize: "11px" }}
              title="返回"
            >
              {onBack ? "✕" : "← 返回"}
            </button>
          </div>
        </div>
        <div className="space-y-2.5">{children}</div>
      </div>
    </div>
  );
}

// 通用确认弹窗：用于删除剧本 / 删除幕等不可逆操作
function ConfirmDialog({
  title,
  message,
  confirmLabel = "删除",
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-[300px] p-5 shadow-xl border border-black/5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1.5">
          <div className="font-semibold text-sm text-[#1a1a1a]">{title}</div>
          <div className="text-xs text-black/50 leading-relaxed">{message}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-xs font-medium bg-black/[0.05] hover:bg-black/[0.08] text-black/60 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2 rounded-xl text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 消息操作条：‹ 1/1 › 多 roll 翻页 + 重 roll + 编辑 + 删除
 * inline=true 时用于卡片底部元信息行右侧（紧凑、低对比）；
 * inline=false 时用于旁白卡（悬浮在右上角）。
 */
function TurnActionBar({
  turn,
  versions,
  index,
  isRerolling,
  canReroll,
  inline = false,
  onReroll,
  onSwitch,
  onEdit,
  onDelete,
}: {
  turn: EnsembleTurn;
  versions?: string[];
  index: number;
  isRerolling: boolean;
  canReroll: boolean;
  inline?: boolean;
  onReroll: () => void;
  onSwitch: (dir: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const total = versions?.length ?? 1;
  const atFirst = index <= 0;
  const atLast = index >= total - 1;

  return (
    <div
      className={`flex items-center gap-1 shrink-0 ${
        inline
          ? "text-black/30"
          : "absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-black/35 bg-white/70 backdrop-blur rounded-lg"
      }`}
    >
      {total > 1 && (
        <>
          <button
            type="button"
            disabled={atFirst}
            onClick={() => onSwitch(-1)}
            className="p-1 disabled:opacity-25 hover:text-black/70"
            title="上一版"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="text-[10px] font-mono tabular-nums">
            {index + 1}/{total}
          </span>
          <button
            type="button"
            disabled={atLast}
            onClick={() => onSwitch(1)}
            className="p-1 disabled:opacity-25 hover:text-black/70"
            title="下一版"
          >
            <ChevronRight size={13} />
          </button>
          <span className="w-px h-3 bg-black/10 mx-0.5" />
        </>
      )}

      {canReroll && (
        <button
          type="button"
          disabled={isRerolling}
          onClick={onReroll}
          className="p-1 hover:text-black/70 disabled:opacity-40"
          title="重新生成本幕"
        >
          <RefreshCw size={12} className={isRerolling ? "animate-spin" : ""} />
        </button>
      )}
      <button
        type="button"
        onClick={onEdit}
        className="p-1 hover:text-black/70"
        title="编辑本幕"
      >
        <Pencil size={12} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 hover:text-red-500"
        title="删除本幕"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * 统一顶栏：不使用 Tailwind h-14，而是复刻项目 .page-shell > .page-header 的 * 定位契约，保证在任何宿主容器下点击都能命中（避免被 .phone-status-bar 覆盖）。
 * 左侧返回键必须始终可点。
 */
function EnsembleHeader({
  title,
  subtitle,
  onBack,
  right,
  showBack = true,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onBack: () => void;
  right?: React.ReactNode;
  showBack?: boolean;
}) {
  return (
    <div
      className="relative z-20 shrink-0 bg-white/80 backdrop-blur-md border-b border-black/[0.06]"
      style={{ paddingTop: "var(--page-header-safe-top, 48px)" }}
    >
      <div className="grid grid-cols-[44px_1fr_44px] items-center px-3 min-h-[42px]">
        {showBack ? (
          <button
            type="button"
            aria-label="返回"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onBack();
            }}
            className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/70 active:scale-90 transition"
            style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          >
            <ChevronLeft size={22} strokeWidth={1.8} />
          </button>
        ) : (
          <span />
        )}
        <div className="flex flex-col items-center min-w-0">
          <div className="text-[15px] font-semibold tracking-tight truncate max-w-full">
            {title}
          </div>
          {subtitle ? (
            <div className="text-[10px] text-black/40 font-mono truncate max-w-full">
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end items-center min-w-[44px]">{right}</div>
      </div>
    </div>
  );
}

interface EnsembleAppProps {
  characters: Character[];
  currentUser?: { name: string; avatar?: string };
  /** 与项目其他 App 统一：关闭当前 App */
  onClose?: () => void;
}

type EnsembleView = "personas" | "scripts" | "create" | "workspace";

export function EnsembleApp({
  characters = [],
  currentUser,
  onClose,
}: EnsembleAppProps) {
  const [scripts, setScripts] = useState<EnsembleScript[]>([]);
  const [currentScript, setCurrentScript] = useState<EnsembleScript | null>(null);
  const [view, setView] = useState<EnsembleView>("personas");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const [titleInput, setTitleInput] = useState("");
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  /** 正在生成中：用于显示「取消生成」（真机中断的唯一途径是卸载本组件） */
  const [isComposing, setIsComposing] = useState(false);

  // ── 「功能」面板（+ 号）及其子弹窗 ──
  const [showToolsSheet, setShowToolsSheet] = useState(false);
  // showPaletteSheet 已删除（卡片配色已移除）
  const [showCssSheet, setShowCssSheet] = useState(false);
  const [showModelSheet, setShowModelSheet] = useState(false);  /** 剧本设置（输出长度）子弹窗 */
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);
  // ── 状态面板 / 时间感知（2026-10-06）──
  const [showStatusSheet, setShowStatusSheet] = useState(false);
  const [showTimeSheet, setShowTimeSheet] = useState(false);
  /** 状态面板草稿（点保存才落库） */
  const [statusEnabledDraft, setStatusEnabledDraft] = useState(false);
  const [statusFieldsDraft, setStatusFieldsDraft] = useState<StatusField[]>([]);
  const [statusTemplateDraft, setStatusTemplateDraft] = useState("");
  /** 时间感知草稿（W1：realtime 由开关 ON/OFF 直接决定，不再单独存草稿） */
  const [timeEnabledDraft, setTimeEnabledDraft] = useState(false);
  const [timeAnchorDraft, setTimeAnchorDraft] = useState("");
  /** 当前正在查看状态卡的角色 id（null = 未打开） */
  const [statusCardTurnId, setStatusCardTurnId] = useState<string | null>(null);
  /** 当前要优先展示的角色 id（点头像时指定；未指定则按数据顺序） */
  const [statusCardMemberId, setStatusCardMemberId] = useState<string | null>(null);
  // ── Settings 全页草稿（图1 · 1006）──
  const [openingDraft, setOpeningDraft] = useState("");
  const [contextDraft, setContextDraft] = useState(10);
  const [povDraft, setPovDraft] = useState<"first" | "second" | "third">("third");
  const [onlineSyncDraft, setOnlineSyncDraft] = useState(false);
  /** 剧本设置里「每轮字数」的草稿值，点保存才落库（= 每个角色各自的字数） */
  const [charsDraft, setCharsDraft] = useState(600);
  /**
   * 字数输入框的**字符串**草稿。
   * 必须与 charsDraft（number）分开：存 number 时清空输入框会被 React 立刻回填 0，
   * 用户无法删干净，再输入就得到「0250」这种带前导 0 的脏值（1006 实机 bug）。
   */
  const [charsInput, setCharsInput] = useState("600");
  const [cssDraft, setCssDraft] = useState("");
  /** 子弹窗打开时缓存的 API 列表（避免每次渲染都读 localStorage） */
  const [apiConfigList, setApiConfigList] = useState<ApiConfig[]>([]);
  /** 轻提示：用于「功能尚未接入」等一次性反馈；非空时 1.8s 后自动消失 */
  const [toast, setToast] = useState<string | null>(null);

  // ── 模型切换（两级：先选 API，再选该 API 下的具体模型） ──
  /** 展开模型二级列表的 API 配置 id（null=停在 API 列表） */
  const [modelPickerApiId, setModelPickerApiId] = useState<string | null>(null);
  /** 一级列表里「工具调用（硅基流动）」折叠组是否展开 */
  const [showHiddenApis, setShowHiddenApis] = useState(false);
  /** 该 API 下的模型名列表 */
  const [modelNameList, setModelNameList] = useState<string[]>([]);
  /** 是否正在拉取模型列表 */
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  /** 拉取模型列表的错误 */
  const [modelListError, setModelListError] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);
  /** 当前解析到的模型名（来自全局设置的 API 配置），用于 MODEL 行 */
  const [lastModel, setLastModel] = useState<string>("");
  /** 最近一次 API 错误，展示在剧情区顶部 */
  const [apiError, setApiError] = useState<string | null>(null);

  // ── 剧本名编辑 ──
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── 消息操作条：多 roll 翻页 ──
  /** turnId → 该幕的多个候选版本（index 0 为原始生成） */
  const [rollsMap, setRollsMap] = useState<Record<string, string[]>>({});
  /** turnId → 当前显示的版本下标 */
  const [rollIndexMap, setRollIndexMap] = useState<Record<string, number>>({});
  /** 正在重 roll 的幕 id */
  const [rerollingTurnId, setRerollingTurnId] = useState<string | null>(null);
  /** 正在编辑的幕 id 与草稿 */
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingTurnDraft, setEditingTurnDraft] = useState("");

  /** 统一删除确认弹窗：解决原「一点就删、无法挽回」的危险操作 */
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── 面具（用户身份）状态 ──────────────────────────────
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);

  useEffect(() => {
    setScripts(loadEnsembleScripts());
    const list = loadUserIdentities();
    setIdentities(list);
    // 默认激活第一个面具（与全局默认绑定一致）
    setActivePersonaId(list[0]?.id ?? null);
  }, []);

  const activePersona =
    identities.find((i) => i.id === activePersonaId) ?? identities[0] ?? null;

  // 当前面具下的角色：角色绑定的面具 === 当前激活面具
  const activeId = activePersona?.id;
  const castableCharacters = activeId
    ? characters.filter((ch) => resolveUserIdentity(ch.id)?.id === activeId)
    : characters;

  // 当前面具下的剧本：剧本 personaId === 当前激活面具
  const visibleScripts = activeId
    ? scripts.filter((s) => !s.personaId || s.personaId === activeId)
    : scripts;

  useEffect(() => {
    if (currentScript) {
      // 载入剧本时先解析一次模型名，保证 MODEL 行即使未生成也有值
      setLastModel(ensembleModelLabel(currentScript.cast[0]?.id));
    }
  }, [currentScript?.id]);

  useEffect(() => {
    if (view === "workspace" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentScript?.turns.length, isGenerating, view]);

  /**
   * 打开 Settings 全页（图1 · 1006）。
   * 顶栏右上角入口 → 先把当前剧本的值灌进草稿，再展示全页。
   */
  const openSettingsPage = () => {
    const s = currentScript;
    if (!s) return;
    // 1006 反馈④：原「场景设定」子弹窗已删除，内容并入开场白。
    // 老剧本只有 background 没 openingMessage → 做一次性迁移，内容不丢。
    setOpeningDraft(s.openingMessage?.trim() ? s.openingMessage : (s.background ?? ""));
    const chars = s.charsPerTurn ?? 600;
    setCharsDraft(chars);
    setCharsInput(String(chars));
    setContextDraft(s.contextLimit ?? 10);
    setPovDraft(s.narrativePov ?? "third");
    setOnlineSyncDraft(s.onlineSync ?? false);
    setShowToolsSheet(false);
    setShowSettingsSheet(true);
  };

  /**
   * 统一返回逻辑：逐层退回，最外层关闭 App。
   * 事件隔离：防止宿主容器的手势/点击监听吞掉本次点击。
   */
  const handleBack = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (view === "workspace") {
      setView("scripts");
    } else if (view === "create") {
      setView("scripts");
    } else if (view === "scripts") {
      if (activePersonaId) {
        setView("personas");
      } else if (typeof onClose === "function") {
        onClose();
      }
    } else if (typeof onClose === "function") {
      onClose();
    }
  };

  // 新建剧本
  const handleCreateScript = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!titleInput.trim()) return;
    const chosenChars = characters.filter((c) => selectedCastIds.includes(c.id));
    const newScript: EnsembleScript = {
      id: "ens_" + Date.now(),
      title: titleInput.trim(),
      personaId: activePersona?.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cast: chosenChars.map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        persona: c.persona || "",
      })),
      turns: [],
    };
    saveOrUpdateEnsembleScript(newScript);
    setScripts(loadEnsembleScripts());
    setCurrentScript(newScript);
    setTitleInput("");
    setSelectedCastIds([]);
    setView("workspace");
  };

  /** 重命名当前剧本（顶栏标题点击进入编辑） */
  const commitTitleRename = () => {
    if (!currentScript) return;
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === currentScript.title) return;
    const updated = { ...currentScript, title: next };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
  };

  /**
   * 触发 AI 生成下一个轮次。
   * @param script     目标剧本
   * @param opts.forceActorId  指定扮演的角色（重 roll 用；缺省则随机挑一个非上轮角色）
   * @param opts.rerollTurnId  重 roll 的目标幕；给出时只返回内容，不落库
   */
  const triggerAiTurn = async (
    script: EnsembleScript,
    opts?: { forceActorId?: string; rerollTurnId?: string }
  ): Promise<string | null> => {
    if (isGenerating || script.cast.length === 0) return null;
    setIsGenerating(true);
    setIsComposing(true);
    if (!opts?.rerollTurnId) setApiError(null);
    try {
      const lastTurn = script.turns[script.turns.length - 1];
      // 只用于「取哪个 API 配置」的绑定锚点：整个剧本走同一套 API，
      // 谁的 id 都行，优先用钦定角色（重 roll），否则用第一个角色。
      const bindActorId = opts?.forceActorId || script.cast[0]?.id;

      // ── 本轮演员表（群像核心）──
      // 关键设计：**由模型按剧情需要决定谁出场、各写多长**，不是由 App 预先钦点。
      // 早先两版都错了：
      //   ① 一版固定「一次只出一个人」→ 群像名存实亡；
      //   ② 一版固定「一轮排 N 个人、每人 X 字」→ 变成配额制，人手一个坑，
      //      剧情被人数和字数绑架，短剧本还会把戏份从别的角色身上匀走。
      // 正确的做法是像写小说：这一轮该谁上场、写多长，由故事本身决定。
      // 所以这里只做「候选范围」的约束（谁在场上、谁禁止出现），
      // 具体点名交给模型，见下方提示词的「选角」段落。
      // forceActorId（重 roll 指定某角色）优先级最高：那就是钦定必须由 TA 开场。
      const forced =
        opts?.forceActorId
          ? script.cast.find((c) => c.id === opts.forceActorId)
          : undefined;

      // 钦定角色（仅重 roll 需要）——整轮回复不再由 App 预设演员表。
      const actorQueue: EnsembleCastMember[] = forced ? [forced] : [];
      const castDesc = script.cast
        .map((c) => `- ${c.name}: ${c.persona || "暂无特别设定"}`)
        .join("\n");

      const userDesc = activePersona
        ? `\n【用户身份设定（你需要在适当时回应 TA）】\n${activePersona.name}：${activePersona.bio || ""}${
            activePersona.customSettings ? ` ${activePersona.customSettings}` : ""
          }`
        : "";
      // 场景设定：有内容就整段作为背景依据注入，没有就不注入。
      //      这只是「导演给的世界观/氛围/隐藏剧情」，不是要求模型把内容抄进正文。
      const sceneBlock = script.background?.trim()
        ? `
【剧本全局场景设定（写作时的背景依据，不是正文内容）】
${script.background.trim()}
`
        : "";

      // 每轮输出长度：剧本级可调（「功能 → 剧本设置」）。
      // charsPerTurn 是给模型看的「整轮总字数目标」；maxTokensPerTurn 是硬护栏。
      //
      // ⚠️ token 护栏的三大坑（此前截断的根因全在这里）：
      //   ① 护栏太紧：整轮目标 chars 直接 ×1.6 换算，没给「多个角色分段」
      //      带来的重复格式开销留量；
      //   ② 最致命的是【thinking 模型】：像 gemini-3.8-flash-high 这类带
      //      思维链的模型，CoT 也计入 maxOutputTokens。护栏按正文换算时，
      //      思考一长就把正文的预算吃光，模型只能草草收笔 ——
      //      这正是截图里 TOKENS=236、以「——」收尾的成因。
      //   ③ 所以这里给 3 倍余量：宁可护栏宽到用不完（模型自己会停），
      //      也绝不让护栏比正文先到。
      const charsPerTurn = Math.max(60, script.charsPerTurn ?? 800);
      const totalChars = charsPerTurn;
      const effectiveMaxTokens =
        script.maxTokensPerTurn ?? charsToMaxTokens(totalChars);
      // 用户公式 M = N + max(400, N × 0.5)：本轮实际允许的字数上限
      const maxChars = targetCharsToMaxChars(charsPerTurn);

      // 上一轮的主说话人：默认只在「被别人搭话」时出现，避免同一人连着霸场。
      const lastSpeakerNote = lastTurn
        ? `\n【上一幕的说话人】${lastTurn.senderName}。除非剧情里有人明确对他开口、他必须回应，否则这一幕请让**别的角色**主导，不要又从头到尾都是他。`
        : "";

      // ── 输出长度控制规则（用户定稿，1006 四次调整：M = N + 200）──
      const outputLenRule = `
【输出长度控制规则】
1. 每轮目标字数 N = ${charsPerTurn} 字，请**尽量写够**，不要草草结束。
2. 系统的硬性 token 上限对应 ${maxChars} 字（比目标多 ${CHARS_TAIL_MARGIN} 字）。
3. 必须在句子、段落完整处收尾，**严禁在句子中间、段落中间突然截断**。
   若发现快要触顶，立即缩短后续内容、优先写完当前这句。
4. 禁止为了凑字数而啰嗦、重复、灌水。`;

      // ── 04 NARRATIVE · 叙事人称（图1）──
      // 1006 第四次反馈 W2/W3（第二版 · 用户实机复验后返工）：
      //   第一版把「旁白禁用他/她」执行成了「凡是人物都写全称」，结果模型把
      //   **本该归到角色头上的动作/心理也塞进旁白块并写全名** → 旁白被污染。
      //   用户原话：「旁白只会说场景，不会说 chars 的内容，都好好归到 chars
      //   自己的内容里」。
      //
      //   第二版正解（本次）：
      //     ① **收紧旁白的内容边界**——旁白只写环境/场景/氛围/时间流逝，
      //        **不得出现任何角色名、角色动作或心理**；人物内容一律归角色自己的
      //        ［叙述］/［动作］/［心理］块。
      //     ② **角色帧内允许代词**——归属行已锚定是谁（渲染时带该角色的头像+名字），
      //        所以角色自己的块里写「他/她」不会歧义，反而是自然的中文。
      //     ③ 用户称呼仍严格按 narrativePov。
      const userName = activePersona?.name || "用户";
      const userPovRule =
        script.narrativePov === "second"
          ? `涉及用户本人时，**必须以「你」指代**（不要写「${userName}」，也不要写「他/她」指代用户）。
     例：✅「你推开门，冷风扑在脸上。」 ❌「${userName}推开门」 ❌「她推开门」（她=用户时）`
          : script.narrativePov === "first"
          ? `涉及用户本人时，**以「我」书写**（对白照常写角色台词，不改）。`
          : `涉及用户本人时，**写全称「${userName}」**，不用「你」，也不用「他/她」代指用户。`;

      const povBlock = `
═══════════ 叙事人称 · 强制规则（与格式铁律同级，违反必须重写）═══════════
当前设定：${
        script.narrativePov === "first"
          ? "第一人称沉浸"
          : script.narrativePov === "second"
          ? "第二人称代入"
          : "第三人称旁观"
      }

【人称铁律 1 · 用户怎么称呼】
${userPovRule}

【人称铁律 2 · 旁白只管「景」，不管「人」】（最容易写错，务必遵守）
［旁白］**只能**写：环境、场景、光线、天气、声音、气味、时间流逝、镜头式的氛围铺陈。
［旁白］里**绝对不允许出现**：
   · 任何角色的**名字**（不许写「金成帝」「皮韩宇」…）
   · 任何角色的**动作**（不许写"他推开门""她坐在窗边"）
   · 任何角色的**心理/情绪**（不许写"他松了口气""她心里一沉"）
   ✅ 正确旁白：「深夜的走廊只剩应急灯，绿光落在墙角。雨声从窗外压进来。」
   ❌ 错误旁白：「金成帝站在门口，他推开门走了进来。」← 这是**人物内容**，不属于旁白

【人称铁律 3 · 人物内容必须归到角色自己的块里】
一个角色的动作 / 神态 / 心理，**必须写在以该角色为归属的** ［叙述］/［动作］/［心理］ 块里，
不能塞进旁白。写法：先写归属行「角色名：」，再写 ［叙述］/［动作］ 块。
   金成帝：
   ［动作］:
   他推开门走进来，肩膀被雨打湿了一片。
   ［心理］:
   这雨下得没个完，他有点烦。

【人称铁律 4 · 角色自己的块里可以用「他/她」】
因为在 ［叙述］/［动作］/［心理］ 块里，归属行已经说清了是谁（渲染时会带这个
角色的头像和名字），所以**用「他/她」不会产生歧义**，反而更自然。
   ✅「他推开门走进来。」（上文归属行已写「金成帝：」）
   ✅「她站在门槛内，看着金成帝转身。」（同段有第二人时才点名区分，其余用代词）

【人称铁律 5 · 对白不受限】
［对白］是角色嘴里说的话，人称照角色自己的说话习惯写，不受以上约束。`;

      // ── 05 MEMORY LINK · 线上互通（图1）──
      // ⚠️ 真实记忆库互通需另接记忆服务；此处仅把开关语义写进提示词，
      //    关闭时明确要求「不得引用线下记忆」，避免模型自行编造跨场景记忆。
      const memoryBlock = script.onlineSync
        ? "\n【线上互通：开启】角色可以自然地「想起」用户在单聊里的相关记忆。"
        : "\n【线上互通：关闭】剧情完全架空，不得引用用户与角色线下/单聊的任何记忆。";

      // ── 01 OPENING · 开场白（图1）──
      const openingBlock = script.openingMessage?.trim()
        ? `
【开场白（本剧第一幕的铺垫，你要基于它自然展开第一幕）】
${script.openingMessage.trim()}
`
        : "";

      // ── 时间感知（2026-10-06）：两种模式都注入，改完下一轮即生效 ──
      //     set 时刻读取（而非组件挂载时），保证「设置好下一轮 AI 就会读到」。
      const storyTime = resolveStoryTime(script.timeAwareness);
      const timeBlock = buildTimeAwarenessBlock(storyTime);

      // ── 状态面板（2026-10-06）：把用户字段表拼成输出契约 ──
      const statusFields = script.statusPanel?.enabled
        ? script.statusPanel.fields ?? []
        : [];
      const statusBlock = statusFields.length
        ? buildStatusContractBlock(
            statusFields,
            script.cast.map((c) => c.name)
          )
        : "";

      const systemPrompt = `你是一位擅长群像叙事的小说作者，正在续写互动剧本《${script.title}》。

🚨 输出格式铁律（违反则整幕作废，必须重写）：
   每一幕**必须以「角色名：」独占一行开头**（如「岳霖玉：」），用来声明归属；
   然后再用 ［对白］/［叙述］/［动作］/［心理］/［旁白］ 五种暗号块承载内容。
   **绝对禁止**直接裸写小说段落、或把动作/台词混在一段里 —— 那样系统无法排版。

═══════════ 参演阵容（全员名单）═══════════
${castDesc}${userDesc}${povBlock}
${sceneBlock}${openingBlock}${memoryBlock}${timeBlock}${outputLenRule}
═══════════ 唯一的格式契约：归属行 + 五种暗号块 ═══════════
排版完全由「行首标记」驱动。规则只有两条：

【第一条 · 归属行】要写某个角色的内容前，先单独占一行写「角色名：」
（中文全角冒号，**这一行除名字和冒号外什么都不写**）。它声明「下面紧跟的
所有暗号块，都归这个角色」。同一角色只需写一次，不用每个块都重复写。
    岳霖玉：

【第二条 · 五种暗号块】归属行之后，每个内容块都以暗号开头，独占一行：
    ［对白］:   → 角色**嘴里说出来的话**（台词）
    ［叙述］:   → **叙述性文字**：动作 / 环境 / 神态
    ［动作］:   → 同［叙述］，也用于动作（两者同义、同色）
    ［心理］:   → 角色**内心**的念头、独白、情绪
    ［旁白］:   → **镜头级旁白**：只写环境/场景/氛围/时间流逝
                 （**不写任何角色名、角色动作或心理**，那些归角色自己的块；
                  旁白不属于任何角色，单独写在归属行之外）

⚠️ 正文里**禁止出现任何其它符号**：不要圆括号（）、不要方括号【】、
   不要引号 ""、不要星号 *、《》、~、#。
   **台词一律不加引号、不加括号**，直接写。
   动作 / 叙述一律放进 ［叙述］/［动作］ 块，**不要裸写在角色名后面**。

═══════════ 双语格式（写死，务必遵守）═══════════
本剧本默认采用双语：只要角色说韩语，就必须**先写韩语原句，紧跟一行中文翻译**。
**中文翻译行不加任何括号**，直接另起一行。固定为：
    ［对白］:
    「밥 먹었어?」
    잘 먹었어.

不得只写中文、也不得只写韩语。翻译行紧跟在韩语下面，不要空行。
如果角色说的是中文，就直接写中文台词，同样不加括号。
［对白］块里可以写多行（韩语 + 中文译文 + 后续中文句），**它们都是台词、都加粗显示**。

【正确示范】多角色 + 叙述 + 旁白 + 心理 + 对白 + 双语混排：
    ［旁白］:
    深夜的走廊只剩应急灯，绿光落在墙角。雨声从窗外压进来。
    岳霖玉：
    ［叙述］:
    她站在门槛内，看着转身准备下楼的金成帝，轻声喊住了他。
    ［对白］:
    「날씨 많이 추운데, 조심해서 가.」
    밖은 많이 추워, 조심해서 가.
    ［心理］:
    她用韩语说话时尾音总是下意识放轻，像怕惊扰到别人一样。
    金成帝：
    ［动作］:
    他停在转角的阴影里，手插在黑色夹克口袋里，侧过头看了她一眼。
    ［对白］:
    「어, 너도 얼른 들어가.」
    알겠어, 너도 얼른 들어가.

（注意：［叙述］/［动作］→ 灰；［心理］→ 与叙述同色；［对白］→ 黑色；
［旁白］→ 淡灰斜体；台词与译文都不加括号。）
⚠️ 注意上面示范：**旁白只写了环境**（灯 / 绿光 / 雨声），**没有一个角色名、没有人物动作**；
   而人物动作（"她站在门槛内…""他停在转角…"）都**归在该角色自己的［叙述］/［动作］块里**，
   块内用「她/他」是允许的（归属行已说清是谁）。

【推荐节奏 · 先叙述后开口】
    每个角色开口**之前**，建议先用一个 ［叙述］/［动作］ 块写他当下的动作或
    神态，再写 ［对白］。这样读者先看到「他在做什么」，再听到「他说什么」，
    画面感更强，也更利于系统排版。不要把动作塞进 ［对白］ 块里。

═══════════ 选角：这一幕谁上场，由你按剧情决定 ═══════════
这是群像剧，核心是**多角色在同一幕里真实互动**，不是轮流独白。

1. 你要自己判断：接着上一幕的情境，**这一幕该有哪几个角色在场**。
   可以是一个人独自反应，也可以两三个人交锋 —— 由故事需要决定，不必每轮人数相同。
2. 但只要这一幕出现了两个及以上角色，他们之间**必须有真实交流**：
   后一个角色要承接、回应、打断或反驳前一个角色的言行，产生摩擦、试探、
   沉默或转折。严禁各写各的、互不相干。
3. 除确有必要，同一幕请优先让**不同角色**都有戏份，不要总是同一个人在说话。
${lastSpeakerNote}
4. 未在本幕出场的角色，一个字都不要替他们写（不要预告、不要提及他们的心理）。

═══════════ 篇幅：由剧情决定，写透为止 ═══════════
5. 这一幕整轮合计约 ${charsPerTurn} 字（这是**参考量级，不是硬指标**）。
   重要的是**把这场戏写完整、写透**：
   - 该展开的冲突、该给的反应、该有的转折，都要写到位，不要因为"怕超字数"提前收笔；
   - 但也不要为了凑字数灌水、重复已知信息、或让角色说废话。
6. 各角色篇幅**不必平均**：谁在这场戏里是重心，谁就多写；
   只是被带到的角色，几句也可以。让节奏自然，不要人均配额。

═══════════ 结尾（此前最容易出错的地方，务必遵守）══════════
7. 你可以让剧情停在悬念上（"话没说完的事" 留给读者想象），
   但**表达本身必须是完整闭合的**：
   - 严禁把句子写到一半就断掉，严禁用「——」「……」「，」作为全篇的最后一个字符；
   - 整段的最后一句必须是语法完整、语义闭合的句子，用句号(。)、问号(？)或叹号(！)收尾。
   - ✅ 正确示范：他伸手去够那个信封，指尖停在半空，终究没有落下去。
   - ❌ 错误示范：他伸手去够那个信封，正要——
   （注意：写"动作进行中"没问题，但要把那个动作写成一句完整的话，而不是切在半途。）

═══════════ 其它硬性要求 ═══════════
8. 严禁输出章节标题、Markdown 标题（#）、序号列表、舞台说明、作者点评或总结。
   严禁跳出角色当作者。
9. 严格贴合每个角色的视角、语气、身份和性格，说话方式要有辨识度。
10. **旁白只写景、不写人**：［旁白］里不得出现任何角色名、角色动作或心理；
   人物内容一律归到该角色自己的 ［叙述］/［动作］/［心理］ 块。
   （角色块内用「他/她」是允许的，归属行已经说清是谁。）
11. 紧扣上一幕推进情节，制造新的张力或情感转折，不要复述已知信息。${statusBlock}`;

      // ── 重 roll 时：剔除被重 roll 的这一幕，只按它之前的上下文重新生成 ──
      const contextTurns = opts?.rerollTurnId
        ? script.turns.filter((t) => t.id !== opts.rerollTurnId)
        : script.turns;

      const messagesPayload = [
        { role: "system", content: systemPrompt },
        ...contextTurns.slice(-(script.contextLimit ?? 10)).map((t) => ({
          role: t.senderType === "user" ? "user" : "assistant",
          // 历史回合按**新契约**回灌，形成格式自强化（模型会跟着学看到的格式）：
          //   · 旁白幕           → `［旁白］:\n正文`
          //   · 角色幕           → `角色名：\n［对白］:\n正文`
          //
          // ⚠️ 必须用**全角方括号** ［］：半角 [ ] 在 JS 模板字符串里会被解析成
          //    数组字面量并求值，方括号会被静默吃掉，模型就再也看不到标记格式。
          //    这正是此前「模型不用方括号、解析器认不出、整幕降级为旁白」的根因。
          content:
            t.senderType === "narration" || t.senderId === "narration"
              ? `［旁白］:\n${t.content}`
              : `${t.senderName}：\n［对白］:\n${t.content}`,
        })),
      ];

      // ── 走绑定桥：从「设置 → API 配置」取真实配置 ──
      const apiConfig = resolveEnsembleApiConfig(
        bindActorId,
        script.apiConfigIdOverride,
        script.modelOverride
      );
      if (!apiConfig) {
        if (!opts?.rerollTurnId) {
          setApiError("尚未配置 API，请到「设置 → API 配置」添加一个可用模型");
        }
        return null;
      }
      setApiError(null);
      if (!opts?.rerollTurnId) {
        setLastModel(apiConfig.defaultModel || apiConfig.name || "未知模型");
      }

      const result = await simpleLLMCall(apiConfig, messagesPayload, {
        temperature: 0.9,
        max_tokens: effectiveMaxTokens,
        // 标签用途只是日志里认人，全员名单可能很长，截断到前 3 个即可。
        label: `群像·${script.cast.slice(0, 3).map((c) => c.name).join("/")}${
          script.cast.length > 3 ? "等" : ""
        }`,
      });

      let replyContent = (result.content || "").trim();
      if (!replyContent) {
        if (!opts?.rerollTurnId) {
          setApiError(result.error || "模型返回空内容");
        }
        return null;
      }

      // 2026-10 修复（图3「岳霖玉：整段斜体灰 + 无头像 + 内容重复」根因）：
      //   旧实现在整段最前面无条件削掉「任意已知角色名 + 冒号」，本意是清理
      //   模型偶尔多写的装饰性署名。但它把两类东西混为一谈：
      //     · 伪署名：模型在正文外多补的一层「［岳霖玉］:」装饰 → 该削
      //     · 真署名：整幕的第一个说话人标记「岳霖玉：」→ 绝不能削
      //   结果是：若模型以「岳霖玉：」而非「［旁白］:」开场，首帧的说话人
      //   标记会被整条吃掉 → 解析器把它当无归属散行兜底成 narration（斜体灰、
      //   无头像），且 pendingHead 还会把这段正文再并进下一个角色的帧 → 内容
      //   重复渲染一遍。
      //
      //   修复策略：不再做「裸角色名开头」的削除。解析器 matchSpeakerPrefix
      //   本来就能正确认领行首署名，这个前置削除纯属多余且有害。
      //   只保留唯一一种真正需要清理的情况：模型把「［角色名］:」这类**方括号
      //   装饰**重复写在了段首（解析器会把方括号内容认成角色名，若与实际正文
      //   说话人重复才需处理）—— 但这种情况交给解析器去认即可，不做前置改写。
      //
      //   因此这里只保留「剥掉整段最前面可能存在的多余空行/装饰符」，不动署名。

      // 截断检测（此前的「东西给我，先——」断句）：
      // ① finishReason=length → 请求侧 token 上限先到，内容被硬切；
      // ② 正文以破折号/省略号/逗号收尾 → 模型自己写到一半停了。
      // token 护栏已按整轮字数 ×3 放宽（含 thinking 余量），①基本不会再触发。
      const brokenTail = /[—–\-]{1,2}\s*$|[.．…]{2,}\s*$|[，,]\s*$/.test(replyContent);
      const hitTokenCap = result.wasTruncated === true;

      if (!opts?.rerollTurnId && (hitTokenCap || brokenTail)) {
        setApiError(
          hitTokenCap
            ? "这一轮被 token 上限截断了（模型没写完）。到「功能 → 剧本设置」把每轮字数调大一点再试。"
            : "这一轮的结尾是断句（模型自己没写完整）。重 roll 一次一般就好。"
        );
      }

      // 重 roll 模式：只把新内容交回调用方（原文保持整段，交给调用方按角色分割）
      if (opts?.rerollTurnId) {
        return replyContent;
      }

      // ── 帧模型（第 1 项：单消息流）──
      // 不再把整幕切成「一人一条 turn」，而是「一条 turn = 整幕原文」。
      // 渲染层再调用 parseEnsembleReply 把它切帧，在同一个消息流里连续渲染，
      // 角色名内联显示（不再一人一张卡）。
      //
      // 为什么要保留整段原文：重 roll（整幕重生成）与编辑都以「幕」为单位，
      // 落库时存原文最稳，不会因解析规则调整而丢失模型原始输出。
      const baseTs = Date.now();
      const baseIso = new Date().toISOString();
      // 解析时带 persona：让「岳霖玉：」这类用户 persona 署名能被认领出帧，
      // 从而 leadFrame 拿得到说话人与头像（否则整幕会被误判为旁白）。
      const parseCast = castWithPersona(script.cast, activePersona);
      const parsed = parseEnsembleReply(replyContent, parseCast, parseCast);
      const frames = parsed.frames;
      // ── 格式健康检查（2026-10 第5轮新增）──
      // 若整幕没有解析出**任何对话帧**，说明模型没按契约写（多半是漏写归属行
      // 或暗号，整幕塌成一坨 narration）→ 用户会看到「无头像、无名字、全灰」。
      // 这时给出明确提示，引导重 roll，而不是让用户对着烂排版发懵。
      const hasDialogue = frames.some((f) => f.kind === "dialogue");
      if (!opts?.rerollTurnId && !hasDialogue) {
        setApiError(
          "这一轮模型没按格式输出（缺少 ［对白］ 块或归属行），整幕会没有头像和名字。建议重 roll 一次。"
        );
      }
      // 说话人署名：整幕可能有多人，取帧里首位有归属的说话人作为「幕主导者」，
      // 用于消息流的时间轴归属与头像兜底（纯旁白幕则记为旁白）。
      const leadFrame = frames.find((f) => f.kind === "dialogue");
      const nextTurn: EnsembleTurn = {
        id: `turn_${baseTs}`,
        senderId: leadFrame?.speakerId ?? (leadFrame ? undefined : "narration"),
        senderName: leadFrame?.speaker ?? "旁白",
        senderType: leadFrame ? "character" : "narration",
        content: replyContent,
        rawText: replyContent,
        timestamp: baseIso,
        tokens: Math.ceil(replyContent.length * 1.3),
        model: apiConfig.defaultModel || apiConfig.name || undefined,
        // 状态数据落库（第六暗号剥离产物）：供点头像查看角色卡。
        // 只有启用状态面板且真的解析出条目才存，避免存空数组。
        statusData: parsed.statusData.length
          ? JSON.stringify(parsed.statusData)
          : undefined,
      };

      let updated = appendEnsembleTurn(script.id, nextTurn) ?? script;
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
      return replyContent;
    } catch (e) {
      console.error("AI turn generation failed:", e);
      return null;
    } finally {
      setIsGenerating(false);
      setIsComposing(false);
    }
  };

  /** 重 roll 某一幕：为该角色再生成一版，追加进 rollsMap 并切到新版本 */
  const handleRerollTurn = async (turn: EnsembleTurn) => {
    if (!currentScript || !turn.senderId || rerollingTurnId) return;
    setRerollingTurnId(turn.id);
    const generated = await triggerAiTurn(currentScript, {
      forceActorId: turn.senderId,
      rerollTurnId: turn.id,
    });
    setRerollingTurnId(null);
    if (!generated) return;

    setRollsMap((prev) => {
      const existing = prev[turn.id] ?? [turn.content];
      const next = [...existing, generated];
      setRollIndexMap((ri) => ({ ...ri, [turn.id]: next.length - 1 }));
      return { ...prev, [turn.id]: next };
    });

    // 立刻把当前展示版本落库，保证退出重进不丢
    const updated = updateEnsembleTurn(currentScript.id, turn.id, {
      content: generated,
      tokens: Math.ceil(generated.length * 1.3),
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  /** 切换某一幕显示的 roll 版本 */
  const switchRoll = (turnId: string, dir: -1 | 1) => {
    if (!currentScript) return;
    const versions = rollsMap[turnId];
    if (!versions || versions.length <= 1) return;
    const cur = rollIndexMap[turnId] ?? 0;
    const next = Math.min(Math.max(cur + dir, 0), versions.length - 1);
    if (next === cur) return;
    setRollIndexMap((prev) => ({ ...prev, [turnId]: next }));
    const updated = updateEnsembleTurn(currentScript.id, turnId, {
      content: versions[next],
      tokens: Math.ceil(versions[next].length * 1.3),
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  /**
   * 删除某一幕。
   *
   * 语义（按需求 1.1）：**一次只删掉当前显示的那一版 roll**。
   * - 该幕还有其它版本 → 只从 rollsMap 移除当前版本，并自动切到相邻版本，幕本身保留；
   * - 只剩最后这一版 → 才真正把整幕从剧本里删掉。
   */
  const removeOneRoll = (turnId: string) => {
    if (!currentScript) return;
    const versions = rollsMap[turnId];
    const cur = rollIndexMap[turnId] ?? 0;

    // 还有多版本：只砍这一版
    if (versions && versions.length > 1) {
      const nextVersions = versions.filter((_, i) => i !== cur);
      const nextIndex = Math.min(cur, nextVersions.length - 1);
      setRollsMap((prev) => ({ ...prev, [turnId]: nextVersions }));
      setRollIndexMap((prev) => ({ ...prev, [turnId]: nextIndex }));

      const updated = updateEnsembleTurn(currentScript.id, turnId, {
        content: nextVersions[nextIndex],
        tokens: Math.ceil(nextVersions[nextIndex].length * 1.3),
      });
      if (updated) {
        setCurrentScript(updated);
        setScripts(loadEnsembleScripts());
      }
      setToast(
        `已删除 1/1 版，剩余 ${nextVersions.length} 版（${nextIndex + 1}/${
          nextVersions.length
        }）`
      );
      return;
    }

    // 最后一版：真正删幕，并清理 roll 记录
    const updated = deleteEnsembleTurn(currentScript.id, turnId);
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
    setRollsMap((prev) => {
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
    setRollIndexMap((prev) => {
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
  };

  /** 组装某一幕的删除确认（文案随剩余版本数变化，避免误删整幕） */  const requestDeleteTurn = (turn: EnsembleTurn) => {
    const total = rollsMap[turn.id]?.length ?? 1;
    const cur = (rollIndexMap[turn.id] ?? 0) + 1;
    setConfirmState({
      title: total > 1 ? `删除第 ${cur} 版？` : "删除这一幕？",
      message:
        total > 1
          ? `这一幕共有 ${total} 个版本，只会删掉你正在看的第 ${cur} 版，其余版本保留，自动切到相邻版本。`
          : `${turn.senderName} 的这一幕将被永久删除，无法恢复。`,
      confirmLabel: total > 1 ? "删除这一版" : "删除",
      onConfirm: () => {
        removeOneRoll(turn.id);
        setConfirmState(null);
      },
    });
  };

  /** 关闭所有子弹窗，回到剧本界面（统一返回语义：不再弹回「功能」面板） */
  const closeAllSheets = () => {
    setShowCssSheet(false);
    setShowSettingsSheet(false);
    setShowModelSheet(false);
    setModelPickerApiId(null);
    setModelListError(null);
    setShowToolsSheet(false);
    // 离开 CSS 面板时丢弃未应用的预览草稿（已保存的 customCss 不受影响）
    setCssDraft(currentScript?.customCss || "");
  };

  // ══════════════════════════════════════════════════════
  // 统一的「一层一层退」导航模型
  // 层级：剧本界面(0) → 功能面板(1) → 子弹窗(2) → 模型二级(3)
  // 顶栏/浮层的返回键都只调 handleSheetBack()，由它决定退到哪一层，
  // 于是不会再出现「子面板点了返回反而弹出功能面板」的错乱。
  // ══════════════════════════════════════════════════════
  // 注：anySheetOpen / sheetIsPrimary 两个派生量曾用于返回键文案，
  // 现已由 handleSheetBack() 自行判定层级（1006 清理），故删除。

  /**
   * 退一层：
   * - 模型二级列表 → 模型一级列表（换 API）
   * - 其余子弹窗 → 「功能」面板（用户要求：子面板关闭后停在功能面板，模糊背景常驻）
   * - 「功能」面板 → 剧本界面
   */
  const handleSheetBack = () => {
    if (showModelSheet && modelPickerApiId) {
      setModelPickerApiId(null);
      setModelListError(null);
      return;
    }
    if (showToolsSheet) {
      // 功能面板本身：整层关闭，回到剧本界面
      closeAllSheets();
      return;
    }
    if (
      showCssSheet ||
      showSettingsSheet ||
      showModelSheet
    ) {
      // Settings 全页（图1）是**全屏页**，返回直接回剧本界面，不弹回功能面板。
      if (showSettingsSheet) {
        setShowSettingsSheet(false);
        return;
      }
      // 其余子弹窗：只关掉自己，保持在功能面板上（背景继续模糊，不重新弹出）
      setShowModelSheet(false);
      setModelPickerApiId(null);
      setModelListError(null);
      setCssDraft(currentScript?.customCss || "");
      setShowToolsSheet(true);
      return;
    }
  };

  /** 中断当前生成：卸载掉正在运行的生成循环（apiError 会带出 AbortError） */
  const cancelGenerating = () => {
    setIsComposing(false);
    setApiError(null);
    setToast("已取消本轮生成");
  };

  /** 打开「模型切换」：默认停在 API 一级列表，重置上次的二级态 */
  const openModelSheet = () => {
    // 这里不做过滤：硅基流动在渲染层被折叠成「工具调用」小按键，需要拿到完整列表。
    setApiConfigList(loadApiConfigs());
    setModelPickerApiId(null);
    setModelNameList([]);
    setModelListError(null);
    setShowHiddenApis(false);
    setShowModelSheet(true);
  };

  /**
   * 进入某个 API 的二级列表（该 API 下的全部模型，需求 1.6）。
   * 优先用配置里已存的可用模型；没有（或为空）时才实时拉取。
   */
  const openModelPickerForApi = async (cfg: ApiConfig) => {
    setModelPickerApiId(cfg.id);
    setModelListError(null);

    const saved = (cfg as ApiConfig & { availableModels?: string[] })
      .availableModels;
    if (Array.isArray(saved) && saved.length > 0) {
      setModelNameList(saved);
      return;
    }

    setModelNameList([]);
    setIsLoadingModels(true);
    try {
      const names = await fetchModelNames(cfg);
      setModelNameList(names);
      if (names.length === 0) setModelListError("该接口未返回任何模型");
    } catch (err) {
      setModelListError(err instanceof Error ? err.message : "拉取模型列表失败");
    } finally {
      setIsLoadingModels(false);
    }
  };

  /** 选中某 API 下的具体模型 → 写进剧本级覆盖（apiConfigIdOverride + modelOverride） */
  const pickModelForApi = (apiId: string, modelName: string) => {
    if (!currentScript) return;
    const updated = {
      ...currentScript,
      apiConfigIdOverride: apiId,
      modelOverride: modelName,
    };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
    setLastModel(modelName);
    setShowModelSheet(false);
    setModelPickerApiId(null);
    setToast(`已切换为 ${modelName}`);
  };

  /** 提交某一幕的编辑 */
  const commitTurnEdit = (turnId: string) => {
    if (!currentScript) return;
    const text = editingTurnDraft.trim();
    setEditingTurnId(null);
    if (!text) return;
    const updated = updateEnsembleTurn(currentScript.id, turnId, {
      content: text,
      tokens: Math.ceil(text.length * 1.3),
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  // 剧幕落库的辅助：写入我的台词（旁白/角色台词统一入口）
  const handleSendTurn = async () => {
    if (!inputText.trim() || !currentScript) return;
    const text = inputText.trim();
    setInputText("");

    const newTurn: EnsembleTurn = {
      id: "turn_" + Date.now(),
      senderId: activePersona?.id || currentUser?.name || "user",
      senderName: activePersona?.name || currentUser?.name || "你",
      senderType: "user",
      content: text,
      timestamp: new Date().toISOString(),
      tokens: Math.ceil(text.length * 1.3),
    };

    const updated = appendEnsembleTurn(currentScript.id, newTurn);
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  // ══════════════════════════════════════════════════════
  // 视图 1：用户面具选择
  // ══════════════════════════════════════════════════════
  if (view === "personas") {
    return (
      <div className="flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="群像剧"
          onBack={() => handleBack()}
          showBack={!!onClose}
        />

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-xs text-black/45 px-1 pt-1">
            选择一个面具，进入它所属的角色群像
          </div>

          {identities.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
              <Users size={36} className="stroke-[1.5]" />
              <div className="text-sm">尚未创建用户面具</div>
              <div className="text-[11px] text-black/30 px-8 leading-relaxed">
                请先到「设置 → 用户面具」中创建面具，并为角色绑定面具后即可在此选择。
              </div>
            </div>
          ) : (
            identities.map((p) => {
              const ownedChars = characters.filter(
                (ch) => resolveUserIdentity(ch.id)?.id === p.id
              );
              const isActive = p.id === activePersonaId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActivePersonaId(p.id);
                    setView("scripts");
                  }}
                  className={`w-full text-left rounded-2xl p-4 border shadow-sm transition active:scale-[0.99] flex items-center gap-3.5 ${
                    isActive
                      ? "border-[#1a1a1a] bg-white"
                      : "border-black/[0.05] bg-white/80 hover:bg-white"
                  }`}
                  style={{ touchAction: "manipulation" }}
                >
                  <div className="w-12 h-12 rounded-full overflow-hidden bg-black/10 flex items-center justify-center text-sm font-semibold shrink-0">
                    {p.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.avatarUrl}
                        alt={p.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      p.name.slice(0, 1)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{p.name}</div>
                    <div className="text-[11px] text-black/45 line-clamp-1 mt-0.5">
                      {p.occupation ? `${p.occupation} · ` : ""}
                      {p.bio || "暂无简介"}
                    </div>
                    <div className="text-[10px] text-black/35 font-mono mt-1">
                      {ownedChars.length} 位角色
                    </div>
                  </div>
                  <ChevronLeft size={18} className="rotate-180 text-black/25 shrink-0" />
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 2：剧本列表（当前面具下）
  // ══════════════════════════════════════════════════════
  if (view === "scripts") {
    return (
      <div className="relative flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="群像剧"
          subtitle={activePersona ? `面具 · ${activePersona.name}` : undefined}
          onBack={(e?: any) => handleBack(e)}
          right={
            <button
              type="button"
              aria-label="新建"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setView("create");
              }}
              className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/70 active:scale-90 transition"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Plus size={22} strokeWidth={1.8} />
            </button>
          }
        />

        {/* 剧本列表（探索群像 tab 已隐藏，代码保留待后续开放） */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {visibleScripts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
              <Users size={36} className="stroke-[1.5]" />
              <div className="text-sm">暂无群像剧</div>
              <button
                type="button"
                onClick={() => setView("create")}
                className="px-4 py-2 bg-[#1a1a1a] text-white rounded-xl text-xs font-medium shadow-sm active:scale-95 transition"
              >
                创建第一个群像剧
              </button>
            </div>
          ) : (
            visibleScripts.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCurrentScript(s);
                  setView("workspace");
                }}
                className="bg-white/80 backdrop-blur-sm border border-black/[0.04] rounded-2xl p-4 shadow-sm active:scale-[0.99] transition cursor-pointer flex flex-col gap-2.5"
                style={{ touchAction: "manipulation" }}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-[#1a1a1a] line-clamp-1">
                    {s.title}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-[10px] text-black/40 font-mono">
                      {s.cast.length} CAST
                    </div>
                    <button
                      type="button"
                      title="删除剧本"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmState({
                          title: "删除这个剧本？",
                          message: `《${s.title}》及其 ${s.turns.length} 幕剧情将被永久删除，无法恢复。`,
                          onConfirm: () => {
                            deleteEnsembleScript(s.id);
                            setScripts(loadEnsembleScripts());
                            setConfirmState(null);
                          },
                        });
                      }}
                      className="p-1 rounded hover:text-red-500 text-black/25"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-black/[0.02]">
                  <div className="flex -space-x-1.5 overflow-hidden">
                    {s.cast.map((c) => (
                      <div
                        key={c.id}
                        className="w-5 h-5 rounded-full border border-white bg-black/10 overflow-hidden flex items-center justify-center text-[8px]"
                      >
                        {c.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatar}
                            alt={c.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          c.name.slice(0, 1)
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-black/35 font-mono">
                    {s.turns.length} 幕
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 删除剧本确认弹窗 */}
        {confirmState && (
          <ConfirmDialog
            title={confirmState.title}
            message={confirmState.message}
            confirmLabel={confirmState.confirmLabel}
            onCancel={() => setConfirmState(null)}
            onConfirm={confirmState.onConfirm}
          />
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 3：创建剧本
  // ══════════════════════════════════════════════════════
  if (view === "create") {
    return (
      <div className="flex flex-col h-full bg-white text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="新建群像剧"
          onBack={(e?: any) => handleBack(e)}
          right={
            <button
              type="button"
              aria-label="完成"
              disabled={!titleInput.trim() || selectedCastIds.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => handleCreateScript(e)}
              className="px-3 h-11 rounded-full text-xs font-semibold text-[#1a1a1a] disabled:opacity-30 active:scale-95 transition inline-flex items-center gap-1"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Check size={16} strokeWidth={2.4} />
              完成
            </button>
          }
        />

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <label className="text-xs font-semibold text-black/60 block mb-1.5">
              剧本标题
            </label>
            <input
              type="text"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="例如：首尔夜色下的群像"
              className="w-full bg-black/[0.03] border border-black/5 rounded-xl px-3 py-2.5 text-xs text-[#1a1a1a] outline-none focus:border-black/20"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-black/60 block mb-2">
              选择参演角色 ({selectedCastIds.length})
            </label>
            {activePersona && (
              <div className="text-[10px] text-black/40 mb-2 px-0.5">
                仅显示绑定到面具「{activePersona.name}」的角色
              </div>
            )}
            {castableCharacters.length === 0 ? (
              <div className="text-xs text-black/35 text-center py-8 bg-black/[0.02] rounded-xl">
                当前面具下暂无绑定角色
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {castableCharacters.map((c) => {
                  const isSelected = selectedCastIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedCastIds((prev) =>
                          isSelected
                            ? prev.filter((id) => id !== c.id)
                            : [...prev, c.id]
                        );
                      }}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border transition text-left ${
                        isSelected
                          ? "border-[#1a1a1a] bg-black/[0.04]"
                          : "border-black/5 bg-black/[0.01]"
                      }`}
                      style={{ touchAction: "manipulation" }}
                    >
                      <div className="w-8 h-8 rounded-full bg-black/10 overflow-hidden flex items-center justify-center text-xs shrink-0">
                        {c.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatar}
                            alt={c.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          c.name.slice(0, 1)
                        )}
                      </div>
                      <div className="text-xs font-medium line-clamp-1">{c.name}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 4：剧本剧场（对话）
  // ══════════════════════════════════════════════════════
  return (
    <div className="ensemble-scope flex flex-col h-full relative bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
      {/* 字号缩放桥接已删除（2026-10）：群像内部字号一律写死，
          不再跟随全局 --app-text-scale，故无需 .ensemble-scope 的 34 行覆盖。 */}

      {/* 剧本级自定义 CSS：仅作用于本 App 的 .ensemble-scope 命名空间 */}
      {/* 用户卡片：输入内容一律纯黑（1006 反馈 R1）。
          用户投稿不切帧，走 BodyText 原样渲染，颜色由这里统一压黑。 */}
      <style jsx global>{`
        .ensemble-scope .frame-user,
        .ensemble-scope .frame-user .frame-body,
        .ensemble-scope .frame-user div,
        .ensemble-scope .frame-user span,
        .ensemble-scope .frame-user p {
          color: #1f1f1f !important;
        }
      `}</style>
      {currentScript?.customCss?.trim() ? (
        <style
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: currentScript.customCss }}
        />
      ) : null}

      {/* CSS 草稿即时预览：编辑面板打开时把草稿注入（不改库）。
          放在已保存样式之后，同优先级下后者覆盖前者，所见即所得。 */}
      {showCssSheet && cssDraft.trim() ? (
        <style
          data-ensemble-css-preview
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: cssDraft }}
        />
      ) : null}
      {!currentScript ? (
        /* 兜底：剧本意外丢失时也不能变成"回不去的白屏" */
        <EnsembleHeader
          title="群像剧"
          onBack={(e?: any) => handleBack(e)}
          showBack={!!onClose}
        />
      ) : (
        <>
          <EnsembleHeader
            title={
              editingTitle ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitleRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTitleRename();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="text-[15px] font-semibold tracking-tight text-center bg-black/[0.05] rounded-lg px-2 py-0.5 outline-none w-full"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(currentScript.title);
                    setEditingTitle(true);
                  }}
                  className="text-[15px] font-semibold tracking-tight truncate max-w-full hover:opacity-70 transition-opacity"
                  title="点击修改剧本名"
                >
                  {currentScript.title}
                </button>
              )
            }
            subtitle={`${currentScript.cast.length} CAST${
              activePersona ? ` · ${activePersona.name}` : ""
            }`}
            /* 顶栏返回 = 离开本剧本，回剧本列表。
               面板的返回统一交给工作区左上角的小返回键（见下方 workspaceBackBtn），
               两者职责分离，不再出现「点了返回却弹出功能面板」的错乱。 */
            onBack={(e?: any) => handleBack(e)}
            /* 1006 反馈 R3：剧本设置入口移到工作区顶栏右上角（原在 + 号功能面板内）。 */
            right={
              <button
                type="button"
                aria-label="剧本设置"
                title="剧本设置"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSettingsPage();
                }}
                className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/50 active:scale-90 transition"
                style={{
                  WebkitTapHighlightColor: "transparent",
                  touchAction: "manipulation",
                }}
              >
                <Settings size={19} strokeWidth={1.9} />
              </button>
            }
          />


          {/* 3.1：顶栏「取消生成」与「← 返回剧本」按键已删除。
              关闭/返回由 MiniSheet 自身顶栏箭头负责，不在工作区顶部重复。 */}

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-5 space-y-[18px] min-h-0"
          >
            {apiError && (
              <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 leading-relaxed">
                API 调用失败：{apiError}
              </div>
            )}

            {currentScript.turns.length === 0 && !isGenerating && (
              <div className="flex flex-col items-center justify-center h-56 text-center text-black/35 space-y-2">
                <Users size={28} className="stroke-[1.5]" />
                <div className="text-xs">剧本已就绪，开始第一幕吧</div>
              </div>
            )}

            {currentScript.turns.map((turn) => {
              const isUser = turn.senderType === "user";
              const isNarrationTurn = turn.senderType === "narration";
              const isNarrator = isNarrationTurn || turn.senderId === "narration";
              const castChar = currentScript.cast.find((c) => c.id === turn.senderId);

              // ── 旁白卡：黑底 P 图标 + NARRATION 标签 ──
              // 仅用于「非帧模型」的历史旁白 turn（旧数据 / 用户手发旁白）。
              // 帧模型生成的整幕（含纯旁白幕）统一走下方帧流渲染。
              // 历史遗留的旁白 turn（非帧模型 / 旧数据）：旁白不是独立卡片，
              // 统一并入下方常规卡片渲染，由帧层负责斜体灰样式。
              if (isNarrator && turn.rawText === undefined) {
                return null;
              }

              return (
                <div
                  key={turn.id}
                  className="group bg-white rounded-[20px] p-5 border border-black/[0.04] space-y-3.5 transition-shadow duration-200 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                >
                  {/* 帧模型：一条 turn 承载整幕，卡内按帧连续渲染，角色名内联。
                      用户投稿（自己写的一幕）不切帧，按原样三色渲染。 */}
                  {isUser || turn.rawText === undefined ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-[10px] bg-black/[0.06] overflow-hidden flex items-center justify-center text-[11px] font-semibold text-black/55 ring-1 ring-black/[0.04]">
                            {castChar?.avatar ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={castChar.avatar}
                                alt={turn.senderName}
                                className="w-full h-full object-cover"
                              />
                            ) : isUser ? (
                              activePersona?.avatarUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={activePersona.avatarUrl}
                                  alt={turn.senderName}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                turn.senderName.slice(0, 1)
                              )
                            ) : (
                              turn.senderName.slice(0, 1)
                            )}
                          </div>
                          <div className="font-semibold text-xs text-[#1a1a1a]">
                            {turn.senderName}
                          </div>
                        </div>
                      </div>

                      {editingTurnId === turn.id ? (
                        <div className="space-y-2">
                          <textarea
                            autoFocus
                            value={editingTurnDraft}
                            onChange={(e) => setEditingTurnDraft(e.target.value)}
                            rows={4}
                            className="w-full bg-black/[0.03] border border-black/10 rounded-xl p-2.5 text-[13.5px] leading-[1.85] outline-none focus:border-black/25 resize-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingTurnId(null)}
                              className="px-3 py-1 text-[11px] text-black/50 hover:bg-black/5 rounded-lg"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => commitTurnEdit(turn.id)}
                              className="px-3 py-1 text-[11px] bg-[#1a1a1a] text-white rounded-lg"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="frame-user">
                          <BodyText raw={turn.content} />
                        </div>
                      )}
                    </>
                  ) : editingTurnId === turn.id ? (
                    <div className="space-y-2">
                      <textarea
                        autoFocus
                        value={editingTurnDraft}
                        onChange={(e) => setEditingTurnDraft(e.target.value)}
                        rows={6}
                        className="w-full bg-black/[0.03] border border-black/10 rounded-xl p-2.5 text-[13.5px] leading-[1.85] outline-none focus:border-black/25 resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingTurnId(null)}
                          className="px-3 py-1 text-[11px] text-black/50 hover:bg-black/5 rounded-lg"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => commitTurnEdit(turn.id)}
                          className="px-3 py-1 text-[11px] bg-[#1a1a1a] text-white rounded-lg"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <EnsembleFrameStream
                      frames={framesOfTurn(
                        turn,
                        castWithPersona(currentScript.cast, activePersona)
                      )}
                      cast={castWithPersona(currentScript.cast, activePersona)}
                      // 启用状态面板且该幕有状态数据时，头像可点 → 弹角色卡
                      onAvatarClick={
                        currentScript.statusPanel?.enabled && turn.statusData
                          ? (speaker) => {
                              const m = currentScript.cast.find(
                                (c) => c.name === speaker
                              );
                              setStatusCardMemberId(m?.id ?? null);
                              setStatusCardTurnId(turn.id);
                            }
                          : undefined
                      }
                    />
                  )}

                  {/* 元信息 + 操作：全部改为竖排列表，避免重 roll 后横排被挤压看不清 */}
                  <div className="pt-2.5 border-t border-black/[0.045] space-y-1.5">
                    <div className="flex flex-col gap-1 text-[10px] text-black/35 font-mono tracking-tight leading-relaxed">
                      <span className="block">
                        DATE {formatMinute(turn.timestamp)}
                      </span>
                      {(turn.model || lastModel) && (
                        <span
                          className="block break-all"
                          title={turn.model || lastModel}
                        >
                          MODEL {turn.model || lastModel}
                        </span>
                      )}
                      {turn.tokens !== undefined && (
                        <span className="block">TOKENS {turn.tokens}</span>
                      )}
                    </div>
                    <div className="flex justify-end pt-0.5">
                      <TurnActionBar
                        turn={turn}
                        versions={rollsMap[turn.id]}
                        index={rollIndexMap[turn.id] ?? 0}
                        isRerolling={rerollingTurnId === turn.id}
                        canReroll={!!turn.senderId && !isUser}
                        inline
                        onReroll={() => handleRerollTurn(turn)}
                        onSwitch={(d) => switchRoll(turn.id, d)}
                        onEdit={() => {
                          setEditingTurnDraft(turn.content);
                          setEditingTurnId(turn.id);
                        }}
                        onDelete={() => requestDeleteTurn(turn)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {isGenerating && (
              <div className="p-4 bg-white/60 rounded-2xl border border-black/5 flex items-center justify-center gap-2 text-xs text-black/40">
                <div className="w-1.5 h-1.5 rounded-full bg-black/30 animate-pulse" />
                <span>剧本正在演进中...</span>
              </div>
            )}
          </div>

          {/* 底部输入栏 */}
          <div
            className="bg-white/80 backdrop-blur-xl border-t border-black/[0.04] px-3 py-2 shrink-0"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
          >
            <div className="flex items-center gap-2">
              {/* 唯一的入口：+ 号 → 底部「功能」面板（旁白/配色/CSS/模型都收进去） */}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setShowToolsSheet(true)}
                className="w-8 h-8 grid place-items-center rounded-full bg-black/[0.05] hover:bg-black/[0.09] text-black/55 shrink-0 active:scale-90 transition"
                title="功能"
                aria-label="功能"
              >
                <Plus size={17} strokeWidth={2} />
              </button>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendTurn();
                  }
                }}
                placeholder={activePersona ? `以「${activePersona.name}」发言...` : "Write your line..."}
                className="flex-1 min-w-0 bg-black/[0.03] border-none outline-none rounded-xl px-3 py-2 text-xs text-[#1a1a1a] placeholder:text-black/25"
              />
              {/* 两段式发送键：
                  有输入 → 发送我的台词；无输入 → 让 AI 演下一轮 */}
              {inputText.trim() ? (
                <button
                  type="button"
                  onClick={() => handleSendTurn()}
                  className="p-2 bg-[#1a1a1a] text-white rounded-xl transition-opacity shrink-0 active:scale-95"
                  title="发送我的台词"
                >
                  <Send size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={() => triggerAiTurn(currentScript)}
                  className="px-3 h-8 bg-[#1a1a1a] text-white rounded-xl text-[11px] font-semibold disabled:opacity-40 transition-opacity shrink-0 active:scale-95"
                  title="让 AI 演下一轮"
                >
                  {isGenerating ? "演绎中" : "下一轮"}
                </button>
              )}
            </div>
          </div>

          {/* 场景设定（1006 反馈④）：已删除本子弹窗，功能并入
              剧本设置页（顶栏右上角）的「开场白」。旧字段 background
              在 openSettingsPage 里做一次性迁移，内容不会丢。 */}

          {/* ═══════════ 功能面板（+ 号） ═══════════ */}
          <EnsembleToolsSheet
            open={showToolsSheet}
            onClose={() => setShowToolsSheet(false)}
            activeIds={
              [
                currentScript.customCss?.trim() ? "customCss" : null,
                currentScript.apiConfigIdOverride ? "model" : null,
                currentScript.timeAwareness?.enabled ? "timeAwareness" : null,
                currentScript.statusPanel?.enabled ? "statusPanel" : null,
              ].filter(Boolean) as EnsembleToolId[]
            }
            onPick={(id) => {
              setShowToolsSheet(false);
              if (id === "customCss") {
                setCssDraft(currentScript.customCss || "");
                setShowCssSheet(true);
              } else if (id === "model") {
                openModelSheet();
              } else if (id === "timeAwareness") {
                const t = currentScript.timeAwareness;
                // W1：开关 ON = 感知现实时间；OFF = 架空时间。
                // 旧数据里可能存着 enabled=true + realtime=false（做反时期），
                // 这里按「开关即语义」归一化，避免读到旧态后界面自相矛盾。
                const on = Boolean(t?.enabled) && (t?.realtime ?? true);
                setTimeEnabledDraft(on);
                // 库里存的是 ISO（2015-03-29T15:54），输入框要显示成
                // 用户当初填的可读格式（2015-03-29 15:54），否则回填会带个 T。
                setTimeAnchorDraft(
                  t?.anchor ? t.anchor.replace("T", " ").slice(0, 16) : ""
                );
                setShowTimeSheet(true);
              } else if (id === "statusPanel") {
                const sp = currentScript.statusPanel;
                setStatusEnabledDraft(sp?.enabled ?? false);
                setStatusFieldsDraft(
                  sp?.fields?.length ? sp.fields : DEFAULT_STATUS_FIELDS
                );
                setStatusTemplateDraft(sp?.template || DEFAULT_STATUS_TEMPLATE);
                setShowStatusSheet(true);
              }
            }}
          />

          {/* 3.3：卡片配色弹窗已删除 */}

          {/* ═══════════ 子弹窗 1：自定义 CSS（命名空间以本项目 .ensemble-frames 为准） ═══════════ */}
          {showCssSheet && (
            <MiniSheet
              title="自定义 CSS"
              subtitle="CUSTOM STYLE · LIVE"
              onClose={() => {
                // 关闭时丢弃"未应用"的预览草稿，避免预览态残留；停在功能面板
                setCssDraft(currentScript.customCss || "");
                setShowCssSheet(false);
                setShowToolsSheet(true);
              }}
            >
              {/* CSS 编辑区 */}
              <div className="bg-white rounded-[16px] p-3.5 space-y-2">
                <div className="text-[10px] leading-relaxed text-black/45">
                  下方 CSS 只作用于本剧本，选择器请以{" "}
                  <span className="font-mono text-black/70 font-semibold">
                    .ensemble-frames
                  </span>{" "}
                  开头（正文容器）。改完点「应用」生效。
                </div>
                {/* 可用类名速查：点一下即插入，降低手写选择器的门槛 */}
                <div className="flex flex-wrap gap-1.5">
                  {[
                    [".ensemble-frames", "正文容器"],
                    [".frame-dialogue", "对白"],
                    [".frame-act", "叙述/动作/心理"],
                    [".frame-narration", "旁白"],
                    [".frame-name", "角色名"],
                  ].map(([sel, label]) => (
                    <button
                      key={sel}
                      type="button"
                      onClick={() =>
                        setCssDraft((v) =>
                          `${v ? v.replace(/\s*$/, "\n\n") : ""}${sel} {\n  \n}`
                        )
                      }
                      className="px-2 py-1 rounded-full bg-black/[0.05] active:scale-95 transition-transform"
                      style={{ fontSize: "9.5px" }}
                      title={`插入 ${label}`}
                    >
                      <span className="font-mono text-black/60">{sel}</span>
                      <span className="text-black/30 ml-1">{label}</span>
                    </button>
                  ))}
                </div>
                <textarea
                  value={cssDraft}
                  onChange={(e) => setCssDraft(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={`/* ========== 群像正文 · 自定义样式 ==========\n   选择器请以 .ensemble-frames 开头，改完点「应用」生效\n\n   .ensemble-frames .frame-dialogue { color: #111; }\n   .ensemble-frames .frame-narration { font-size: 13.5px; }\n*/`}
                  className="w-full bg-black/[0.03] border border-black/5 rounded-xl p-3 text-[10.5px] font-mono text-[#111111] placeholder:text-black/25 outline-none focus:border-black/20 resize-none leading-relaxed"
                />
              </div>

              {/* 底部按钮 */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setCssDraft(currentScript.customCss || "");
                    setShowCssSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const updated = { ...currentScript, customCss: cssDraft };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    // 应用 = 功能键完成 → 关掉本层，停在功能面板
                    setShowCssSheet(false);
                    setShowToolsSheet(true);
                    setToast("自定义 CSS 已生效");
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-[#111111] text-[14px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  应用
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 3：时间感知（图3 · 1006） ═══════════ */}
          {showTimeSheet && (
            <MiniSheet
              title="时间感知"
              subtitle="TIME AWARENESS"
              onClose={() => {
                setShowTimeSheet(false);
                setShowToolsSheet(true);
              }}
            >
              <div className="bg-white rounded-[16px] p-4 space-y-4">
                <StatusToggleRow
                  label="感知现实时间"
                  hint="让 AI 知道此刻的真实年月日与钟点"
                  checked={timeEnabledDraft}
                  onChange={setTimeEnabledDraft}
                />

                {/* 开关语义（1006 第四次反馈·W1 定稿）：
                      · ON  感知现实时间 → 只有开关，**不出现任何时间选择界面**
                      · OFF 架空时间     → 出现架空起点输入，保存即生效
                    此前实现做反了：ON 时仍显示锚点区、且需额外点「改用架空起点」
                    才切换模式。现直接由开关 ON/OFF 决定 realtime。 */}
                {!timeEnabledDraft && (
                  <div className="space-y-2">
                    <div className="text-[10.5px] text-black/45 leading-relaxed">
                      已关闭「感知现实时间」→ 剧情时间架空。填写一个起点，时间会从
                      这个点起随现实自然流逝。保存即生效。
                    </div>
                    {/* W1（第二版 · 用户实机复验后返工）：
                        原生 datetime-local 控件在移动端点起来很麻烦（用户："使用不方便，
                        改直接输入"）。改为**手动文本输入**，并明确格式，AI 好识别。
                        解析时容忍常见分隔符（- / . 年月日 空格 时:分）。 */}
                    <input
                      type="text"
                      inputMode="numeric"
                      value={timeAnchorDraft}
                      onChange={(e) => setTimeAnchorDraft(e.target.value)}
                      placeholder="2015-03-29 15:54"
                      spellCheck={false}
                      className="w-full bg-black/[0.03] border border-black/[0.07] rounded-[12px] px-3 py-3 font-mono text-[13px] text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25"
                    />
                    <div className="text-[10px] text-black/35 leading-relaxed">
                      格式：<span className="font-mono">YYYY-MM-DD HH:mm</span>
                      （例 <span className="font-mono">2015-03-29 15:54</span>），24 小时制。
                    </div>
                    {timeAnchorDraft.trim() && !isValidTimeAnchor(timeAnchorDraft) && (
                      <div className="text-[10px] text-[#c0392b] leading-relaxed">
                        格式无法识别，请按 <span className="font-mono">YYYY-MM-DD HH:mm</span> 填写。
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowTimeSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // W1：架空模式下起点必填且格式必须可识别（否则时间感知形同虚设）
                    const anchor =
                      timeEnabledDraft || !timeAnchorDraft.trim()
                        ? undefined
                        : normalizeTimeAnchor(timeAnchorDraft);
                    if (!timeEnabledDraft && timeAnchorDraft.trim() && !anchor) {
                      setToast(
                        "架空起点格式不对，请按 YYYY-MM-DD HH:mm 填写（例 2015-03-29 15:54）"
                      );
                      return;
                    }
                    const updated: EnsembleScript = {
                      ...currentScript,
                      timeAwareness: {
                        // W1 定稿：enabled = 是否启用时间感知；
                        // realtime 直接由开关决定 ——
                        //   ON  → 跟随现实时间（realtime=true，无时间界面）
                        //   OFF → 架空时间（realtime=false，用 anchor）
                        enabled: timeEnabledDraft,
                        realtime: timeEnabledDraft,
                        anchor: anchor ?? undefined,
                      },
                    };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setShowTimeSheet(false);
                    setShowToolsSheet(true);
                    setToast("时间感知已保存 · 下一轮生效");
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-[#111111] text-[14px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  保存
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 4：状态面板（图 · 1006） ═══════════ */}
          {showStatusSheet && (
            <MiniSheet
              title="状态面板"
              subtitle="STATUS · FULLY CUSTOM"
              onClose={() => {
                setShowStatusSheet(false);
                setShowToolsSheet(true);
              }}
            >
              {/* 启用开关 */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusToggleRow
                  label="启用状态面板"
                  hint="开启后 AI 按字段表为每个角色生成数据，点头像查看"
                  checked={statusEnabledDraft}
                  onChange={setStatusEnabledDraft}
                />
              </div>

              {/* ① 字段 / DATA */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusSectionHead
                  num="①"
                  label="字段 / DATA"
                  labelEn="FIELDS"
                  right={
                    <span className="text-[10px] text-black/30">
                      你定数据 · AI 照填
                    </span>
                  }
                />
                <div className="text-[10.5px] text-black/45 leading-relaxed mb-3">
                  key 给模板取值{"{​{key}}"} 用；说明是给 AI 看的话；字数是软上限（留空不限）。
                  0-100 的数字字段可在模板里用{" "}
                  <span className="font-mono text-black/60">{"{{key.bar}}"}</span>{" "}
                  渲染进度条。
                </div>
                <StatusFieldEditor
                  fields={statusFieldsDraft}
                  onChange={setStatusFieldsDraft}
                />
                <div className="mt-3">
                  <StatusFieldActions
                    onAdd={() =>
                      setStatusFieldsDraft((v) => [
                        ...v,
                        { key: "", desc: "", max: undefined },
                      ])
                    }
                    onReset={() => setStatusFieldsDraft(DEFAULT_STATUS_FIELDS)}
                  />
                </div>
              </div>

              {/* ② 模板 / TEMPLATE */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusSectionHead
                  num="②"
                  label="模板 / TEMPLATE"
                  labelEn="HTML · CSS · JS"
                  right={
                    <button
                      type="button"
                      onClick={() => setStatusTemplateDraft(DEFAULT_STATUS_TEMPLATE)}
                      className="text-[10.5px] text-black/45 active:scale-95 transition-transform"
                    >
                      恢复默认模板
                    </button>
                  }
                />
                <StatusTemplateEditor
                  fields={statusFieldsDraft}
                  template={statusTemplateDraft}
                  onChange={setStatusTemplateDraft}
                />
              </div>

              {/* 底部按钮 */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowStatusSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const updated: EnsembleScript = {
                      ...currentScript,
                      statusPanel: {
                        enabled: statusEnabledDraft,
                        fields: statusFieldsDraft.filter((f) => f.key.trim()),
                        template: statusTemplateDraft,
                        engine: "html",
                      },
                    };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setShowStatusSheet(false);
                    setShowToolsSheet(true);
                    setToast("状态面板已保存 · 下一轮生效");
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-[#111111] text-[14px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  保存
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 状态卡展示层（点头像 → 单角色卡片） ═══════════ */}
          {(() => {
            if (!statusCardTurnId) return null;
            const turn = currentScript.turns.find((t) => t.id === statusCardTurnId);
            if (!turn) return null;
            const entries: EnsembleStatusEntry[] = (() => {
              try {
                return turn.statusData ? JSON.parse(turn.statusData) : [];
              } catch {
                return [];
              }
            })();
            if (!entries.length) return null;
            // 出场角色 = 状态数据里能对上演员表的人（保序）
            const members = entries
              .map((e) =>
                currentScript.cast.find(
                  (c) => c.id === e.memberId || c.name === e.name
                )
              )
              .filter((c): c is EnsembleCastMember => Boolean(c));
            if (!members.length) return null;
            // 状态卡时间：严格取本轮剧情时间
            const storyTime = resolveStoryTime(currentScript.timeAwareness);
            // 若用户点头像指定了某个角色，把它排到最前
            const ordered = statusCardMemberId
              ? [
                  ...members.filter((m) => m.id === statusCardMemberId),
                  ...members.filter((m) => m.id !== statusCardMemberId),
                ]
              : members;
            return (
              <EnsembleStatusCardLayer
                members={ordered}
                entries={entries}
                storyTime={storyTime}
                template={currentScript.statusPanel?.template}
                onClose={() => setStatusCardTurnId(null)}
              />
            );
          })()}


          {showSettingsSheet && (() => {
            // 与 triggerAiTurn 共用同一套换算（charsToMaxTokens），
            // 保证面板上写的就是真实发出去的护栏值。
            const effectiveTokens = charsToMaxTokens(charsDraft);
            // 用户公式 M = N + max(400, N × 0.5)：给用户看的「实际最多多少字」
            const maxChars = targetCharsToMaxChars(charsDraft);
            const numBadge = (n: string) => (
              <span className="font-mono text-[10px] text-black/20 tracking-widest">
                {n}
              </span>
            );
            const sectionHead = (
              icon: React.ReactNode,
              label: string,
              num: string
            ) => (
              <div className="flex items-center gap-2 mb-2.5">
                <span className="w-6 h-6 rounded-[4px] bg-[#111111] grid place-items-center text-white shrink-0">
                  {icon}
                </span>
                <span
                  className="tracking-[0.22em] font-semibold text-black/45 flex-1"
                  style={{ fontSize: "10.5px" }}
                >
                  {label}
                </span>
                {numBadge(num)}
              </div>
            );
            return (
              <div className="absolute inset-0 z-[56] bg-[#f2f2f4] flex flex-col">
                {/* 顶栏：毛玻璃磨砂条 + ‹ Settings / ENSEMBLE · CONFIGURATION
                    1006 反馈③：原先顶部贴边太紧、与工作区衔接突兀。
                    修法：补一条与工作区同款的毛玻璃顶栏（sticky），
                    下移到与工作区顶栏一致的视觉基线，做出「从工作区平推入」的观感。 */}
                <div className="sticky top-0 z-10 shrink-0 bg-[#f2f2f4]/85 backdrop-blur-xl border-b border-black/[0.06]">
                  <div className="flex items-center gap-2.5 px-4 pt-3 pb-3">
                    <button
                      type="button"
                      onClick={() => {
                        setShowSettingsSheet(false);
                        setShowToolsSheet(false);
                      }}
                      className="w-9 h-9 -ml-1 grid place-items-center rounded-full hover:bg-black/5 text-black/60 active:scale-90 transition"
                    aria-label="返回"
                  >
                    <ChevronLeft size={22} strokeWidth={1.8} />
                  </button>
                  <div className="min-w-0">
                    <div className="text-[21px] font-bold tracking-tight text-[#111111] leading-none">
                      Settings
                    </div>
                    <div
                      className="tracking-[0.22em] font-medium text-black/25 mt-1.5"
                      style={{ fontSize: "9px" }}
                    >
                      ENSEMBLE · CONFIGURATION
                    </div>
                  </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6 space-y-4">
                  {/* 01 OPENING */}
                  <div>
                    {sectionHead(<MessageSquare size={13} strokeWidth={2} />, "OPENING", "01")}
                    <div className="bg-white rounded-[16px] p-4">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13.5px] font-semibold text-[#111111]">
                          Opening Message / 开场白
                        </span>
                        <span
                          className="tracking-[0.18em] font-medium text-black/25 px-1.5 py-0.5 rounded bg-black/[0.04]"
                          style={{ fontSize: "8.5px" }}
                        >
                          EDITABLE
                        </span>
                      </div>
                      <div className="text-[10px] text-black/35 mt-1 mb-2.5">
                        铺垫群像的第一幕场景
                      </div>
                      <textarea
                        value={openingDraft}
                        onChange={(e) => setOpeningDraft(e.target.value)}
                        rows={5}
                        placeholder="开场白写在这里，AI 会基于它展开第一幕…"
                        className="w-full bg-black/[0.03] border border-black/8 rounded-xl p-3 text-[12.5px] leading-[1.85] text-[#1f1f1f] placeholder:text-black/25 outline-none focus:border-black/25 resize-none"
                      />
                    </div>
                  </div>

                  {/* 02 GENERATION */}
                  <div>
                    {sectionHead(<Wrench size={13} strokeWidth={2} />, "GENERATION", "02")}
                    <div className="bg-white rounded-[16px] p-4 space-y-3">
                      <div>
                        <div className="text-[13.5px] font-semibold text-[#111111]">
                          每轮字数 / Reply Length
                        </div>
                        <div className="text-[10px] text-black/35 mt-1">
                          AI 每次回复的目标字数
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div className="flex-1 flex items-center justify-center gap-1.5 bg-black/[0.03] border border-black/10 rounded-[12px] h-12 px-3">
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={charsInput}
                            onChange={(e) => {
                              // 1006 反馈：直接输入，不要 ＋/－ 按钮；
                              // 输入时必须能删干净（不留首位数字）。
                              // 因此草稿存**字符串**而非 number —— 若存 number，
                              // 清空会立刻被 React 回填成 0，再次输入就变成 "0250"。
                              const raw = e.target.value.replace(/[^\d]/g, "");
                              if (raw === "") {
                                setCharsInput("");
                                return;
                              }
                              // 去掉前导 0（"0250" → "250"，但 "0" 本身保留以便继续输入）
                              const normalized = raw.replace(/^0+(?=\d)/, "");
                              setCharsInput(normalized);
                            }}
                            onBlur={() => {
                              // 失焦时才把草稿收敛成合法数字并回写
                              const n = Number(charsInput);
                              const safe = Number.isFinite(n) && n > 0
                                ? Math.min(CHARS_MAX, Math.max(CHARS_MIN, Math.round(n)))
                                : 600;
                              setCharsDraft(safe);
                              setCharsInput(String(safe));
                            }}
                            className="w-full bg-transparent text-center text-[16px] font-bold text-[#111111] tabular-nums outline-none [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-[11px] text-black/40 shrink-0">字</span>
                        </div>
                      </div>
                      <div className="text-[10px] leading-relaxed text-black/40">
                        想让 AI 每轮写多长。它会尽量写够 {charsDraft} 字，并在
                        <span className="text-black/60">本句完整处收尾</span>，
                        不会写到一半被切断。
                      </div>
                    </div>
                  </div>

                  {/* 03 CONTEXT */}
                  <div>
                    {sectionHead(<Clock size={13} strokeWidth={2} />, "CONTEXT", "03")}
                    <div className="bg-white rounded-[16px] p-4">
                      <div className="text-[13.5px] font-semibold text-[#111111]">
                        Context Limit / 记忆轮数
                      </div>
                      <div className="text-[10px] text-black/35 mt-1 mb-2.5">
                        每次请求发送最近多少轮对话给 AI
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={1}
                          max={30}
                          step={1}
                          value={contextDraft}
                          onChange={(e) => setContextDraft(Number(e.target.value))}
                          className="flex-1 accent-[#111111]"
                        />
                        <span className="text-[15px] font-bold text-[#111111] tabular-nums shrink-0">
                          {contextDraft}
                          <span className="text-[10px] font-medium text-black/40 ml-0.5">轮</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 04 NARRATIVE */}
                  <div>
                    {sectionHead(<Eye size={13} strokeWidth={2} />, "NARRATIVE", "04")}
                    <div className="bg-white rounded-[16px] p-4 space-y-2">
                      <div>
                        <div className="text-[13.5px] font-semibold text-[#111111]">
                          Narrative POV / 叙事人称
                        </div>
                      </div>
                      {(
                        [
                          ["first", "第一人称沉浸", "角色动作用「我」描写，对白照常"],
                          ["second", "第二人称代入", "镜头跟着你，称呼你为「你」"],
                          ["third", "第三人称旁观", "所有人用名字，像小说"],
                        ] as const
                      ).map(([val, label, desc]) => {
                        const on = povDraft === val;
                        return (
                          <button
                            key={val}
                            type="button"
                            onClick={() => setPovDraft(val)}
                            className={`w-full flex items-start gap-2.5 text-left rounded-[12px] px-3 py-2.5 transition-colors ${
                              on ? "bg-black/[0.05]" : "hover:bg-black/[0.03]"
                            }`}
                          >
                            <span
                              className={`w-4 h-4 rounded-full border-[1.5px] grid place-items-center shrink-0 mt-0.5 ${
                                on ? "border-[#111111]" : "border-black/25"
                              }`}
                            >
                              {on && <span className="w-2 h-2 rounded-full bg-[#111111]" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[12.5px] font-medium text-[#111111]">
                                {label}
                                {val === "third" && (
                                  <span className="text-black/35 font-normal"> · 群像推荐</span>
                                )}
                              </span>
                              <span className="block text-[10px] text-black/35 mt-0.5">{desc}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 05 MEMORY LINK */}
                  <div>
                    {sectionHead(<Layers size={13} strokeWidth={2} />, "MEMORY LINK", "05")}
                    <div className="bg-white rounded-[16px] p-4 space-y-2">
                      <div>
                        <div className="text-[13.5px] font-semibold text-[#111111]">
                          Online Sync / 线上互通
                        </div>
                        <div className="text-[10px] text-black/35 mt-1">
                          开启后记忆双向流通：角色在剧里「想起」你与线上聊天的记忆，剧里发生的事他们回到单聊也记得（需启用记忆库）
                        </div>
                      </div>
                      {(
                        [
                          [true, "开启", "线上线下记忆互通"],
                          [false, "关闭 · 默认", "完全架空，与线上世界隔离"],
                        ] as const
                      ).map(([val, label, desc]) => {
                        const on = onlineSyncDraft === val;
                        return (
                          <button
                            key={String(val)}
                            type="button"
                            onClick={() => setOnlineSyncDraft(val)}
                            className={`w-full flex items-start gap-2.5 text-left rounded-[12px] px-3 py-2.5 transition-colors ${
                              on ? "bg-black/[0.05]" : "hover:bg-black/[0.03]"
                            }`}
                          >
                            <span
                              className={`w-4 h-4 rounded-full border-[1.5px] grid place-items-center shrink-0 mt-0.5 ${
                                on ? "border-[#111111]" : "border-black/25"
                              }`}
                            >
                              {on && <span className="w-2 h-2 rounded-full bg-[#111111]" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[12.5px] font-medium text-[#111111]">
                                {label}
                              </span>
                              <span className="block text-[10px] text-black/35 mt-0.5">{desc}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 底部：SAVE DATA + 清空记录 */}
                  <button
                    type="button"
                    onClick={() => {
                      const updated: EnsembleScript = {
                        ...currentScript,
                        openingMessage: openingDraft,
                        charsPerTurn: charsDraft,
                        maxTokensPerTurn: undefined,
                        contextLimit: contextDraft,
                        narrativePov: povDraft,
                        onlineSync: onlineSyncDraft,
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setToast("已保存");
                    }}
                    className="w-full py-3.5 rounded-[14px] bg-[#111111] text-white text-[13px] font-semibold tracking-[0.16em] inline-flex items-center justify-center gap-2 active:scale-[0.985] transition-transform"
                  >
                    <Check size={15} strokeWidth={2.4} />
                    SAVE DATA
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "清空本剧本的全部记录？此操作不可撤销（剧本与演员表保留）。"
                        )
                      )
                        return;
                      const updated: EnsembleScript = { ...currentScript, turns: [] };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setToast("记录已清空");
                    }}
                    className="w-full py-3.5 rounded-[14px] bg-white text-[#d9534f] text-[12.5px] font-medium inline-flex items-center justify-center gap-2 active:scale-[0.985] transition-transform"
                  >
                    <Eraser size={14} strokeWidth={2} />
                    清空记录 · CLEAR LOG
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ═══════════ 子弹窗 3：模型切换（两级：API → 该 API 下的具体模型） ═══════════ */}
          {showModelSheet && (() => {
            const activeApi = modelPickerApiId
              ? apiConfigList.find((c) => c.id === modelPickerApiId)
              : undefined;

            // ── 二级：某个 API 下的全部模型 ──
            if (activeApi) {
              return (
                <MiniSheet
                  title={activeApi.name || "未命名配置"}
                  subtitle="MODELS · SESSION"
                  onClose={() => {
                    // 只关本层 → 回到模型一级列表
                    setModelPickerApiId(null);
                    setModelListError(null);
                  }}
                  onBack={() => {
                    // 同层内的次级导航：同样回一级（与顶栏「← 返回」保持一致）
                    setModelPickerApiId(null);
                    setModelListError(null);
                  }}
                  backLabel="换 API"
                >
                  {isLoadingModels && (
                    <div className="bg-white rounded-[16px] p-5 text-center text-[12px] text-black/40">
                      正在拉取该接口的模型列表…
                    </div>
                  )}

                  {!isLoadingModels && modelListError && (
                    <div className="bg-white rounded-[16px] p-5 space-y-3">
                      <div className="text-[12px] text-[#b42318] leading-relaxed">
                        {modelListError}
                      </div>
                      <button
                        type="button"
                        onClick={() => openModelPickerForApi(activeApi)}
                        className="w-full py-3 rounded-[14px] bg-black/[0.05] text-[13px] font-medium text-black/60 active:scale-[0.985] transition-transform"
                      >
                        重试
                      </button>
                    </div>
                  )}

                  {!isLoadingModels && !modelListError && modelNameList.length === 0 && (
                    <div className="bg-white rounded-[16px] p-5 text-center text-[12px] text-black/40">
                      该接口未返回模型
                    </div>
                  )}

                  {!isLoadingModels &&
                    !modelListError &&
                    modelNameList.length > 0 && (
                      // 固定 6 行高度（每行 h-[50px] + 行间距 gap-2），超出在内部滚动；
                      // padding 给选中态/缩放留出余量，避免贴边裁切。
                      <div className="max-h-[318px] overflow-y-auto overscroll-contain -mx-1 px-1 space-y-2">
                        {modelNameList.map((name) => {
                          const selected =
                            currentScript.apiConfigIdOverride === activeApi.id &&
                            currentScript.modelOverride === name;
                          return (
                            <button
                              key={name}
                              type="button"
                              onClick={() => pickModelForApi(activeApi.id, name)}
                              className="w-full h-[50px] flex items-center gap-3 px-3.5 rounded-[16px] bg-white text-left active:scale-[0.985] transition-transform"
                            >
                              <span className="flex-1 min-w-0 block text-[14px] font-medium text-[#111111] truncate leading-snug">
                                {name}
                              </span>
                              {selected && (
                                <Check size={18} className="text-[#111111] shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                </MiniSheet>
              );
            }

            // ── 一级：可选 API 列表 ──
            // 硅基流动属于「工具调用」范畴（记忆向量等），默认折叠。
            // 开关放在「返回」键旁边，尽量小 —— 不占列表位置、也不抢视觉。
            const hiddenApiCount = apiConfigList.filter(
              (cfg) => cfg.provider === "SiliconFlow"
            ).length;
            return (
              <MiniSheet
                title="模型切换"
                subtitle="API · SESSION ONLY"
                onClose={() => {
                  setShowModelSheet(false);
                  setModelPickerApiId(null);
                  setModelListError(null);
                  setShowToolsSheet(true);
                }}
                headerAction={
                  hiddenApiCount > 0 ? (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setShowHiddenApis((v) => !v)}
                      className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full active:scale-95 transition-transform ${
                        showHiddenApis
                          ? "bg-[#111111] text-white"
                          : "bg-black/[0.06] text-black/40"
                      }`}
                      style={{ fontSize: "10px" }}
                      title="工具调用（硅基流动）"
                    >
                      <Wrench size={10} strokeWidth={2} />
                      工具调用
                      <span className="tabular-nums opacity-60">{hiddenApiCount}</span>
                    </button>
                  ) : null
                }
              >
                <div className="bg-white rounded-[14px] px-4 py-3 mb-2">
                  <div className="text-[11.5px] leading-relaxed text-black/50">
                    仅在群像内临时生效，<span className="text-black/70 font-medium">不会改动设置页</span>。可让聊天与总结用不同模型。
                  </div>
                </div>

                {(() => {
                  // 硅基流动只服务于「全局设置 → 记忆向量」等系统级工具，默认不作为群像对话模型，
                  // 所以不作为普通项平铺，而是收拢到一行小按键里；点一下才展开。
                  const visibleApis = apiConfigList.filter(
                    (cfg) => cfg.provider !== "SiliconFlow"
                  );
                  const hiddenApis = apiConfigList.filter(
                    (cfg) => cfg.provider === "SiliconFlow"
                  );

                  const renderApiRow = (cfg: ApiConfig) => {
                    const apiSelected = currentScript.apiConfigIdOverride === cfg.id;
                    return (
                      <button
                        key={cfg.id}
                        type="button"
                        onClick={() => openModelPickerForApi(cfg)}
                        className="w-full flex items-center gap-3.5 px-3.5 py-3.5 rounded-[16px] bg-white text-left active:scale-[0.985] transition-transform"
                      >
                        <span
                          className={`w-11 h-11 rounded-[13px] shrink-0 grid place-items-center ${
                            apiSelected ? "bg-[#111111]" : "bg-black/[0.08]"
                          }`}
                        >
                          <Layers
                            size={19}
                            strokeWidth={1.9}
                            className={apiSelected ? "text-white" : "text-black/45"}
                          />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[15px] font-semibold tracking-tight text-[#111111] truncate">
                            {cfg.name || "未命名配置"}
                          </span>
                          <span className="block text-[9.5px] tracking-[0.16em] font-medium text-black/30 mt-1 truncate">
                            {apiSelected && currentScript.modelOverride
                              ? currentScript.modelOverride
                              : cfg.defaultModel || cfg.provider || "UNKNOWN"}
                          </span>
                        </span>
                        <div className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-black/15 bg-white">
                          <span className="text-[10px] font-semibold tracking-wider text-black/60">MODEL</span>
                          <ChevronDown size={12} strokeWidth={2.5} className="text-black/40" />
                        </div>
                      </button>
                    );
                  };

                  if (apiConfigList.length === 0) {
                    return (
                      <div className="bg-white rounded-[16px] p-5 text-center text-[12px] text-black/40">
                        尚未配置 API，请到「设置 → API 配置」添加
                      </div>
                    );
                  }

                  return (
                    <>
                      {visibleApis.map(renderApiRow)}

                      {/* 工具调用（硅基流动）：开关在顶栏返回键旁边，这里只负责按开关状态显示 */}
                      {showHiddenApis && hiddenApis.map(renderApiRow)}
                    </>
                  );
                })()}

                {(currentScript.apiConfigIdOverride ||
                  currentScript.modelOverride) && (
                  <button
                    type="button"
                    onClick={() => {
                      const updated = {
                        ...currentScript,
                        apiConfigIdOverride: undefined,
                        modelOverride: undefined,
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setLastModel(ensembleModelLabel(currentScript.cast[0]?.id));
                      setToast("已恢复跟随全局默认");
                    }}
                    className="w-full py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                  >
                    跟随全局默认
                  </button>
                )}

                {/* 底部「完成」按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    setShowModelSheet(false);
                    setModelPickerApiId(null);
                    setModelListError(null);
                    setShowToolsSheet(true);
                  }}
                  className="w-full py-3.5 rounded-[16px] bg-[#111111] text-[14px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  完成
                </button>
              </MiniSheet>
            );
          })()}

          {/* ═══════════ 轻提示 ═══════════ */}
          {toast && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-[70] px-4 py-2 rounded-full bg-[#111111] text-white text-[12px] font-medium shadow-lg pointer-events-none">
              {toast}
            </div>
          )}

          {/* 统一删除确认弹窗 */}
          {confirmState && (
            <ConfirmDialog
              title={confirmState.title}
              message={confirmState.message}
              confirmLabel={confirmState.confirmLabel}
              onCancel={() => setConfirmState(null)}
              onConfirm={confirmState.onConfirm}
            />
          )}
        </>
      )}
    </div>
  );
}
