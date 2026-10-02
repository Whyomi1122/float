"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Send,
  Trash2,
  Users,
  Compass,
  X,
  Check,
  RefreshCw,
  Pencil,
  Layers,
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
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  appendEnsembleTurn,
  deleteEnsembleTurn,
  updateEnsembleTurn,
} from "@/lib/ensemble-storage";

// ══════════════════════════════════════════════════════════
// API 绑定桥（Ensemble ↔ 全局设置里的 API 配置）
// 走项目标准链路：loadBindingConfig → resolveBinding → loadApiConfigs
// appId 使用 "ensemble"（已注册进 ContentAppId），可在
// 「设置 → 绑定」里为群像单独指定 API，未指定则继承全局默认。
// ══════════════════════════════════════════════════════════

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

// 三色视觉定义（对齐目标截图：不出现彩色高亮）
// 灰阶梯度承担层级：对白最深 → 动作深灰 → 心理浅灰，三层都适合长文阅读。
export const GS_COLORS = {
  dial: "#111111", // 对白：深黑（最实，视觉重心）
  act: "#5f5f66",  // 动作与环境描写：深灰
  inn: "#8e8e93",  // 心理与神态：浅灰（最轻，退到背景层）
};

/** 把剧本级配色覆盖合并进默认三色（空值回落到默认） */
export function resolvePalette(override?: {
  dial?: string;
  act?: string;
  inn?: string;
}): typeof GS_COLORS {
  if (!override) return GS_COLORS;
  return {
    dial: override.dial?.trim() || GS_COLORS.dial,
    act: override.act?.trim() || GS_COLORS.act,
    inn: override.inn?.trim() || GS_COLORS.inn,
  };
}

interface TriColorSegment {
  type: "act" | "dial" | "inn" | "plain";
  text: string;
}

// 解析三色格式
export function parseTriColor(raw: string): TriColorSegment[] {
  if (!raw) return [];
  const segments: TriColorSegment[] = [];
  const regex = /(?:[（\(]([^）\)]*)[）\)])|(?:["“]([^"”]*)[”"])|(?:[【\[]([^】\]]*)[】\]])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const plainText = raw.slice(lastIndex, match.index);
      if (plainText) segments.push({ type: "plain", text: plainText });
    }
    if (match[1] !== undefined) {
      segments.push({ type: "act", text: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ type: "dial", text: match[2] });
    } else if (match[3] !== undefined) {
      segments.push({ type: "inn", text: match[3] });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < raw.length) {
    const trailing = raw.slice(lastIndex);
    if (trailing) segments.push({ type: "plain", text: trailing });
  }

  return segments;
}

// 三色文本分段排版组件（对齐目标截图）
// - 对白：深黑，居中/常规排版，去引号
// - 动作与环境：中灰小字
// - 心理与神态：中灰（同动作系），去方括号
// 全篇不出现左侧竖线、彩色边框、琥珀金高亮。
function TriColorText({
  raw,
  prefix,
  palette,
}: {
  raw: string;
  prefix?: "u";
  palette?: typeof GS_COLORS;
}) {
  const segs = parseTriColor(raw);
  const pal = palette ?? GS_COLORS;
  return (
    <div className="text-[14.5px] leading-[1.9] tracking-[0.01em] text-[#2c2c2c] space-y-3">
      {segs.map((s, i) => {
        if (s.type === "plain") {
          const text = s.text.trim();
          if (!text) return null;
          return (
            <div key={i} className="whitespace-pre-wrap text-[#2c2c2c]">
              {text}
            </div>
          );
        }

        if (s.type === "act") {
          // 动作与环境描写：中灰，稍小字号，斜体感由灰度承担
          return (
            <div
              key={i}
              style={{ color: pal.act }}
              className="whitespace-pre-wrap text-[13.5px] leading-[1.85]"
            >
              {s.text}
            </div>
          );
        }

        if (s.type === "inn") {
          // 心理与神态：中灰（与动作同系，不做彩色区分）
          return (
            <div
              key={i}
              style={{ color: pal.inn }}
              className="whitespace-pre-wrap text-[13.5px] leading-[1.85]"
            >
              {s.text}
            </div>
          );
        }

        // 对白：深黑，核心内容，去引号直接呈现
        return (
          <div
            key={i}
            style={{ color: pal.dial }}
            className="whitespace-pre-wrap font-medium leading-[1.85] -mt-0.5"
          >
            {s.text}
          </div>
        );
      })}
    </div>
  );
}

// 旁白卡：复刻目标截图的「黑底 P 图标 + NARRATION 标签」样式
function NarrationCard({
  text,
  timestamp,
}: {
  text: string;
  timestamp?: string;
}) {
  return (
    <div className="flex gap-3.5 bg-white rounded-[20px] px-5 py-4 border border-black/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <div className="w-9 h-9 rounded-[11px] bg-[#111111] shrink-0 grid place-items-center">
        <span className="text-white text-[13px] font-bold leading-none">P</span>
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="text-[9.5px] tracking-[0.2em] font-semibold text-black/35 mb-2">
          NARRATION
        </div>
        <TriColorText raw={text} />
        {timestamp ? (
          <div className="mt-2 text-[10px] text-black/30 font-mono">
            {timestamp.slice(0, 10)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 通用底部子弹窗：与「功能」面板同一套视觉（浅灰底、圆角、居中标题）
// onBack：关闭后要回到哪一层（需求 1.5——子弹窗返回「功能」面板，而不是直接回剧情界面）
function MiniSheet({
  title,
  subtitle,
  onClose,
  onBack,
  backLabel = "返回",
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-[55] flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#f2f2f4] rounded-t-[26px] px-4 pt-6 pb-5 max-h-[88%] overflow-y-auto"
      >
        <div className="px-1.5 mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className="font-bold tracking-tight text-[#111111] leading-none"
              style={{ fontSize: "calc(20px * var(--app-text-scale, 1))" }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                className="tracking-[0.2em] font-medium text-black/30 mt-2"
                style={{ fontSize: "calc(10px * var(--app-text-scale, 1))" }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="shrink-0 px-2.5 py-1.5 rounded-full bg-white text-black/45 active:scale-95 transition-transform"
              style={{ fontSize: "calc(11px * var(--app-text-scale, 1))" }}
              title="返回功能列表"
            >
              ← {backLabel}
            </button>
          )}
        </div>
        <div className="space-y-2.5">{children}</div>
        {onBack ? (
          <div className="flex items-center gap-2.5 mt-3">
            <button
              type="button"
              onClick={onBack}
              className="flex-1 py-3.5 rounded-[16px] bg-[#111111] font-semibold text-white active:scale-[0.985] transition-transform"
              style={{ fontSize: "calc(14px * var(--app-text-scale, 1))" }}
            >
              返回功能
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3.5 rounded-[16px] bg-white/70 font-medium text-black/55 active:scale-[0.985] transition-transform"
              style={{ fontSize: "calc(14px * var(--app-text-scale, 1))" }}
            >
              关闭
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="w-full mt-3 py-3.5 rounded-[16px] bg-white/70 font-medium text-black/55 active:scale-[0.985] transition-transform"
            style={{ fontSize: "calc(14px * var(--app-text-scale, 1))" }}
          >
            取消
          </button>
        )}
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
  const [showNarrationModal, setShowNarrationModal] = useState(false);
  const [narrationSettingText, setNarrationSettingText] = useState("");

  // ── 「功能」面板（+ 号）及其子弹窗 ──
  const [showToolsSheet, setShowToolsSheet] = useState(false);
  const [showPaletteSheet, setShowPaletteSheet] = useState(false);
  const [showCssSheet, setShowCssSheet] = useState(false);
  const [showModelSheet, setShowModelSheet] = useState(false);
  const [cssDraft, setCssDraft] = useState("");
  /** 子弹窗打开时缓存的 API 列表（避免每次渲染都读 localStorage） */
  const [apiConfigList, setApiConfigList] = useState<ApiConfig[]>([]);
  /** 轻提示：用于「功能尚未接入」等一次性反馈；非空时 1.8s 后自动消失 */
  const [toast, setToast] = useState<string | null>(null);

  // ── 模型切换（两级：先选 API，再选该 API 下的具体模型） ──
  /** 展开模型二级列表的 API 配置 id（null=停在 API 列表） */
  const [modelPickerApiId, setModelPickerApiId] = useState<string | null>(null);
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
      setNarrationSettingText(currentScript.background || "");
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
      narrationEnabled: false,
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
    if (!opts?.rerollTurnId) setApiError(null);
    try {
      const lastTurn = script.turns[script.turns.length - 1];
      let nextActor = script.cast[0];
      if (opts?.forceActorId) {
        nextActor =
          script.cast.find((c) => c.id === opts.forceActorId) ?? script.cast[0];
      } else if (lastTurn) {
        const otherActors = script.cast.filter((c) => c.id !== lastTurn.senderId);
        if (otherActors.length > 0) {
          nextActor = otherActors[Math.floor(Math.random() * otherActors.length)];
        }
      }

      const castDesc = script.cast
        .map((c) => `- ${c.name}: ${c.persona || "暂无特别设定"}`)
        .join("\n");

      const userDesc = activePersona
        ? `\n【用户身份设定（你需要在适当时回应 TA）】\n${activePersona.name}：${activePersona.bio || ""}${
            activePersona.customSettings ? ` ${activePersona.customSettings}` : ""
          }`
        : "";

      // 旁白与背景设定：仅在 narrationEnabled 为真时注入提示词
      const narrationBlock =
        script.narrationEnabled && script.background?.trim()
          ? `\n【剧本全局旁白与背景设定】\n${script.background.trim()}\n`
          : "";

      const systemPrompt = `你正在参与一场名为《${script.title}》的群像互动剧本。
当前参演角色阵容：
${castDesc}${userDesc}
${narrationBlock}
你现在必须【完全代入并扮演角色：${nextActor.name}】。

═══════════ 输出格式铁律（违反即失败）═══════════
这是硬性约束，优先级高于一切写作习惯，必须逐条执行：

1. 只输出你扮演的「${nextActor.name}」一个人的内容。
   严禁替其他角色写台词、写动作、写心理。
   严禁使用「${nextActor.name}：」「${nextActor.name}说」这类前缀。
   严禁输出任何章节标题、Markdown 标题、序号或舞台说明。

2. 正文只用下面三种标记包裹，除此之外不得出现任何其他符号（不要书名号《》、不要波浪号、不要星号 *、不要井号 #、不要破折号堆叠）：
   （动作或环境细节）   —— 全角圆括号
   "台词内容"           —— 全角双引号
   【内心独白】          —— 全角方括号

3. 三色语义严格对应，不得串用：
   圆括号（）= 动作、神态、环境变化 —— 唯一允许描写外部动作的地方
   双引号"" = 说出口的对白台词 —— 唯一允许出现说话内容的地方
   方括号【】= 心理活动、未说出口的念头

4. 台词必须放在双引号里，不得裸写；心理活动必须放进方括号，不得混在动作里。

5. 篇幅 150～400 字。宁短勿长，写不完就留到下一轮，不要匆忙收尾。
   结尾必须留一个「未完成动作」或「未说完的话」，把戏剧张力交给下一位角色。

6. 禁止总结、禁止旁白点评、禁止跳出角色。你就是 ${nextActor.name}，不是作者。
═══════════════════════════════════════

写作要求：
1. 严格贴合《${nextActor.name}》的视角、语气、身份和性格，说话方式要有辨识度。
2. 紧扣上一幕的情节推进，自然地产生新的张力、冲突或情感转折，不要复述已知信息。
3. 允许与上一个说话的角色产生直接交流（回应 TA 的话、打断、反问），但不要替 TA 发言。`;

      // 重 roll 时：剔除被重 roll 的这一幕，只按它之前的上下文重新生成
      const contextTurns = opts?.rerollTurnId
        ? script.turns.filter((t) => t.id !== opts.rerollTurnId)
        : script.turns;

      const messagesPayload = [
        { role: "system", content: systemPrompt },
        ...contextTurns.slice(-10).map((t) => ({
          role: t.senderType === "user" ? "user" : "assistant",
          content: `[${t.senderName}]: ${t.content}`,
        })),
      ];

      // ── 走绑定桥：从「设置 → API 配置」取真实配置 ──
      const apiConfig = resolveEnsembleApiConfig(
        nextActor.id,
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
        temperature: 0.85,
        max_tokens: script.maxTokensPerTurn ?? 8192,
        label: `群像·${nextActor.name}`,
      });

      let replyContent = (result.content || "").trim();
      if (!replyContent) {
        if (!opts?.rerollTurnId) {
          setApiError(result.error || "模型返回空内容");
        }
        return null;
      }

      replyContent = replyContent.replace(new RegExp(`^\\[?${nextActor.name}\\]?[:：]?\\s*`), "").trim();

      // 重 roll 模式：只把新内容交回调用方，由调用方决定怎么更新 rollsMap
      if (opts?.rerollTurnId) {
        return replyContent;
      }

      const nextTurn: EnsembleTurn = {
        id: "turn_" + Date.now(),
        senderId: nextActor.id,
        senderName: nextActor.name,
        senderType: "character",
        content: replyContent,
        timestamp: new Date().toISOString(),
        tokens: Math.ceil(replyContent.length * 1.3),
        model: apiConfig.defaultModel || apiConfig.name || undefined,
      };

      const updated = appendEnsembleTurn(script.id, nextTurn);
      if (updated) {
        setCurrentScript(updated);
        setScripts(loadEnsembleScripts());
      }
      return replyContent;
    } catch (e) {
      console.error("AI turn generation failed:", e);
      return null;
    } finally {
      setIsGenerating(false);
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

  /** 子弹窗「返回」：先关掉所有子弹窗，再重新打开「功能」面板（需求 1.5） */
  const backToTools = () => {
    setShowPaletteSheet(false);
    setShowCssSheet(false);
    setShowModelSheet(false);
    setModelPickerApiId(null);
    setModelListError(null);
    setShowToolsSheet(true);
  };

  /** 打开「模型切换」：默认停在 API 一级列表，重置上次的二级态 */
  const openModelSheet = () => {
    setApiConfigList(loadApiConfigs());
    setModelPickerApiId(null);
    setModelNameList([]);
    setModelListError(null);
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
  // 三色配色：剧本级覆盖优先，空值回落到 GS_COLORS 灰阶梯度
  const palette = resolvePalette(currentScript?.palette);

  return (
    <div className="ensemble-scope flex flex-col h-full relative bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
      {/* 剧本级自定义 CSS：仅作用于本 App 的 .ensemble-scope 命名空间 */}
      {currentScript?.customCss?.trim() ? (
        <style
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: currentScript.customCss }}
        />
      ) : null}
      {!currentScript ? (
        /* 兜底：剧本意外丢失时也不能变成"回不去的白屏" */
        <EnsembleHeader title="群像剧" onBack={(e?: any) => handleBack(e)} />
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
            onBack={(e?: any) => handleBack(e)}
          />

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
              if (isNarrator) {
                return (
                  <div key={turn.id} className="group relative">
                    <NarrationCard text={turn.content} timestamp={turn.timestamp} />
                    <TurnActionBar
                      turn={turn}
                      versions={rollsMap[turn.id]}
                      index={rollIndexMap[turn.id] ?? 0}
                      isRerolling={rerollingTurnId === turn.id}
                      canReroll={!isNarrator}
                      onReroll={() => handleRerollTurn(turn)}
                      onSwitch={(d) => switchRoll(turn.id, d)}
                      onEdit={() => {
                        setEditingTurnDraft(turn.content);
                        setEditingTurnId(turn.id);
                      }}
                      onDelete={() => requestDeleteTurn(turn)}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={turn.id}
                  className="group bg-white rounded-[20px] p-5 border border-black/[0.04] space-y-3.5 transition-shadow duration-200 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                >
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
                    <TriColorText
                      raw={turn.content}
                      prefix={isUser ? "u" : undefined}
                      palette={palette}
                    />
                  )}

                  {/* 元信息 + 操作：全部改为竖排列表，避免重 roll 后横排被挤压看不清 */}
                  <div className="pt-2.5 border-t border-black/[0.045] space-y-1.5">
                    <div className="flex flex-col gap-1 text-[10px] text-black/35 font-mono tracking-tight leading-relaxed">
                      <span className="block">DATE {turn.timestamp.slice(0, 10)}</span>
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

          {/* 旁白与场景设定弹窗 */}
          {showNarrationModal && (
            <div className="absolute inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl w-full max-w-sm p-4 shadow-xl border border-black/5 flex flex-col gap-3">
                <div className="flex items-center justify-between pb-2 border-b border-black/5">
                  <span className="font-semibold text-sm text-[#1a1a1a]">
                    旁白与场景设定
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowNarrationModal(false)}
                    className="p-1 hover:bg-black/5 rounded-full text-black/40"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* 是否启用旁白：关闭时这段设定不会注入 AI 提示词 */}
                <button
                  type="button"
                  onClick={() => {
                    const next = !(currentScript.narrationEnabled);
                    const updated = { ...currentScript, narrationEnabled: next };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-xs font-medium transition-colors ${
                    currentScript.narrationEnabled
                      ? "bg-black/[0.05] border-black/10 text-[#1a1a1a]"
                      : "bg-black/[0.02] border-black/5 text-black/45"
                  }`}
                >
                  <span>启用旁白</span>
                  <span
                    className={`w-9 h-5 rounded-full relative transition-colors ${
                      currentScript.narrationEnabled ? "bg-[#1a1a1a]" : "bg-black/20"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                        currentScript.narrationEnabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </span>
                </button>

                <div className="text-xs text-black/50">
                  设定当前剧本的宏观环境、旁白氛围或隐藏剧情要求，AI 会严格遵从。
                </div>

                <textarea
                  value={narrationSettingText}
                  onChange={(e) => setNarrationSettingText(e.target.value)}
                  placeholder="例如：深夜首尔街头下着淅淅沥沥的冷雨，角色们刚结束高强度的工作，彼此心情沉重但都克制着情绪..."
                  rows={5}
                  className="w-full bg-black/[0.03] border border-black/5 rounded-xl p-3 text-xs text-[#1a1a1a] placeholder:text-black/30 outline-none focus:border-black/20 resize-none leading-relaxed"
                />

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setNarrationSettingText("");
                      const updated = { ...currentScript, background: "" };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setShowNarrationModal(false);
                    }}
                    className="px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg"
                  >
                    清空
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const updated = {
                        ...currentScript,
                        background: narrationSettingText.trim(),
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setShowNarrationModal(false);
                    }}
                    className="px-4 py-1.5 bg-[#1a1a1a] text-white rounded-xl text-xs font-medium"
                  >
                    保存设定
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════ 功能面板（+ 号） ═══════════ */}
          <EnsembleToolsSheet
            open={showToolsSheet}
            onClose={() => setShowToolsSheet(false)}
            activeIds={
              [
                currentScript.narrationEnabled && currentScript.background?.trim()
                  ? "narration"
                  : null,
                currentScript.palette ? "palette" : null,
                currentScript.customCss?.trim() ? "customCss" : null,
                currentScript.apiConfigIdOverride ? "model" : null,
              ].filter(Boolean) as EnsembleToolId[]
            }
            onPick={(id) => {
              setShowToolsSheet(false);
              if (id === "narration") {
                setNarrationSettingText(currentScript.background || "");
                setShowNarrationModal(true);
              } else if (id === "palette") {
                setShowPaletteSheet(true);
              } else if (id === "customCss") {
                setCssDraft(currentScript.customCss || "");
                setShowCssSheet(true);
              } else if (id === "model") {
                openModelSheet();
              }
            }}
          />

          {/* ═══════════ 子弹窗 1：卡片配色（灰阶梯度 + 可自定义） ═══════════ */}
          {showPaletteSheet && (
            <MiniSheet
              title="卡片配色"
              subtitle="RECEIPT COLOR"
              onClose={() => setShowPaletteSheet(false)}
              onBack={backToTools}
            >
              <div className="bg-white rounded-[16px] p-4 space-y-3.5">
                {(
                  [
                    { key: "dial", label: "对白", hint: "说出口的台词" },
                    { key: "act", label: "动作", hint: "动作、神态与环境" },
                    { key: "inn", label: "心理", hint: "内心的独白" },
                  ] as const
                ).map((row) => {
                  const current = resolvePalette(currentScript.palette)[row.key];
                  return (
                    <div key={row.key} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-[#111111]">
                          {row.label}
                        </div>
                        <div className="text-[10px] text-black/35 mt-0.5">{row.hint}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className="text-[11px] font-mono text-black/40"
                          style={{ color: current }}
                        >
                          {current}
                        </span>
                        <input
                          type="color"
                          value={current}
                          onChange={(e) => {
                            const next = {
                              ...resolvePalette(currentScript.palette),
                              [row.key]: e.target.value,
                            };
                            const updated = { ...currentScript, palette: next };
                            setCurrentScript(updated);
                            saveOrUpdateEnsembleScript(updated);
                            setScripts(loadEnsembleScripts());
                          }}
                          className="w-9 h-9 rounded-[10px] border border-black/10 bg-white cursor-pointer p-0.5"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  const updated = { ...currentScript, palette: undefined };
                  setCurrentScript(updated);
                  saveOrUpdateEnsembleScript(updated);
                  setScripts(loadEnsembleScripts());
                  setToast("已恢复默认灰阶配色");
                }}
                className="w-full py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
              >
                恢复默认
              </button>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 2：自定义 CSS ═══════════ */}
          {showCssSheet && (
            <MiniSheet
              title="自定义 CSS"
              subtitle="CUSTOM STYLE"
              onClose={() => setShowCssSheet(false)}
              onBack={backToTools}
            >
              <div className="bg-white rounded-[16px] p-3.5 space-y-2.5">
                <div className="text-[10.5px] leading-relaxed text-black/45">
                  只作用于本 App 的画面。用 <span className="font-mono">.ensemble-scope</span>{" "}
                  作为前缀即可命中（例如{" "}
                  <span className="font-mono">.ensemble-scope .rounded-2xl {"{...}"}</span>）。
                </div>
                <textarea
                  value={cssDraft}
                  onChange={(e) => setCssDraft(e.target.value)}
                  rows={9}
                  spellCheck={false}
                  placeholder={".ensemble-scope {\n  /* 例：整体圆角与留白 */\n}"}
                  className="w-full bg-black/[0.03] border border-black/5 rounded-xl p-3 text-[11px] font-mono text-[#111111] placeholder:text-black/25 outline-none focus:border-black/20 resize-none leading-relaxed"
                />
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    const updated = { ...currentScript, customCss: "" };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setCssDraft("");
                    setToast("已清空自定义 CSS");
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-white text-[14px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const updated = { ...currentScript, customCss: cssDraft };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setShowCssSheet(false);
                    setToast("自定义 CSS 已生效");
                  }}
                  className="flex-1 py-3.5 rounded-[16px] bg-[#111111] text-[14px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  应用
                </button>
              </div>
            </MiniSheet>
          )}

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
                  onClose={() => setShowModelSheet(false)}
                  onBack={() => setModelPickerApiId(null)}
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
                    modelNameList.map((name) => {
                      const selected =
                        currentScript.apiConfigIdOverride === activeApi.id &&
                        currentScript.modelOverride === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => pickModelForApi(activeApi.id, name)}
                          className="w-full flex items-center gap-3 px-3.5 py-3.5 rounded-[16px] bg-white text-left active:scale-[0.985] transition-transform"
                        >
                          <span className="flex-1 min-w-0 block text-[14px] font-medium text-[#111111] break-all leading-snug">
                            {name}
                          </span>
                          {selected && (
                            <Check size={18} className="text-[#111111] shrink-0" />
                          )}
                        </button>
                      );
                    })}
                </MiniSheet>
              );
            }

            // ── 一级：可选 API 列表 ──
            return (
              <MiniSheet
                title="模型切换"
                subtitle="API · SESSION"
                onClose={() => setShowModelSheet(false)}
                onBack={backToTools}
              >
                <div className="px-1 pb-1 text-[11px] leading-relaxed text-black/35">
                  先选一条 API，再选该 API 下的具体模型。只对本剧本生效，不改动全局设置。
                </div>

                {apiConfigList.length === 0 ? (
                  <div className="bg-white rounded-[16px] p-5 text-center text-[12px] text-black/40">
                    尚未配置 API，请到「设置 → API 配置」添加
                  </div>
                ) : (
                  apiConfigList.map((cfg) => {
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
                        <ChevronRight
                          size={17}
                          strokeWidth={2}
                          className="text-black/25 shrink-0"
                        />
                      </button>
                    );
                  })
                )}

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
