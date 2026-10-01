"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  Plus,
  Play,
  Send,
  Trash2,
  Users,
  Compass,
  X,
  Check,
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
import type { UserIdentity } from "@/components/settings/user-identity";
import {
  EnsembleScript,
  EnsembleTurn,
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  appendEnsembleTurn,
  deleteEnsembleTurn,
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
 * 级联：全局默认 → 角色默认 → 群像 app 覆盖 → 角色在群像上的覆盖。
 * 兜底：若级联结果为空（例如用户清空了全局默认），退到第一条 API 配置。
 */
export function resolveEnsembleApiConfig(characterId?: string): ApiConfig | null {
  const configs = loadApiConfigs();
  if (configs.length === 0) return null;
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, ENSEMBLE_APP_ID);
    if (slot.apiConfigId) {
      const found = configs.find((c) => c.id === slot.apiConfigId);
      if (found) return found;
    }
  } catch (e) {
    console.warn("[ensemble] resolveEnsembleApiConfig failed:", e);
  }
  return configs[0];
}

/** 供 UI 显示用的模型名（真实取自全局设置里选中的那条 API 配置） */
export function ensembleModelLabel(characterId?: string): string {
  const cfg = resolveEnsembleApiConfig(characterId);
  if (!cfg) return "未配置 API";
  return cfg.defaultModel || cfg.name || cfg.provider || "未知模型";
}

// 三色视觉定义（GS典雅群像规范）
export const GS_COLORS = {
  dial: "#1a1a1a", // 对话：高质感深黑粗体
  act: "#6e6e73",  // 动作与描写：典雅克制灰
  inn: "#a16207",  // 心理与神态：暗金琥珀
};

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

// 三色文本分段排版组件
function TriColorText({ raw, prefix }: { raw: string; prefix?: "u" }) {
  const segs = parseTriColor(raw);
  return (
    <div className="text-[14.5px] leading-[1.8] tracking-wide text-[#2c2c2c] space-y-3">
      {segs.map((s, i) => {
        if (s.type === "plain") {
          const text = s.text.trim();
          if (!text) return null;
          return (
            <div key={i} className="whitespace-pre-wrap">
              {text}
            </div>
          );
        }
        const color =
          s.type === "dial"
            ? GS_COLORS.dial
            : s.type === "act"
            ? GS_COLORS.act
            : GS_COLORS.inn;

        const wrap =
          s.type === "dial"
            ? `"${s.text}"`
            : s.type === "act"
            ? `（${s.text}）`
            : `【${s.text}】`;

        return (
          <div
            key={i}
            style={{ color }}
            className={`whitespace-pre-wrap ${
              s.type === "act"
                ? "opacity-75"
                : s.type === "dial"
                ? "font-medium"
                : "opacity-90"
            }`}
          >
            {wrap}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 统一顶栏：不使用 Tailwind h-14，而是复刻项目 .page-shell > .page-header 的
 * 定位契约，保证在任何宿主容器下点击都能命中（避免被 .phone-status-bar 覆盖）。
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
  const [activeTab, setActiveTab] = useState<"my_ensembles" | "discover">("my_ensembles");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const [titleInput, setTitleInput] = useState("");
  const [bgInput, setBgInput] = useState("");
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showNarrationModal, setShowNarrationModal] = useState(false);
  const [narrationSettingText, setNarrationSettingText] = useState("");
  /** 当前解析到的模型名（来自全局设置的 API 配置），用于 MODEL 行 */
  const [lastModel, setLastModel] = useState<string>("");
  /** 最近一次 API 错误，展示在剧情区顶部 */
  const [apiError, setApiError] = useState<string | null>(null);
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
      background: bgInput.trim(),
      // 剧本绑定当前激活面具
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
    setBgInput("");
    setSelectedCastIds([]);
    setView("workspace");
  };

  // 触发 AI 生成下一个轮次
  const triggerAiTurn = async (script: EnsembleScript) => {
    if (isGenerating || script.cast.length === 0) return;
    setIsGenerating(true);
    setApiError(null);
    try {
      const lastTurn = script.turns[script.turns.length - 1];
      let nextActor = script.cast[0];
      if (lastTurn) {
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

      const systemPrompt = `你正在参与一场名为《${script.title}》的群像互动剧本。
当前参演角色阵容：
${castDesc}${userDesc}

【剧本全局旁白与背景设定】
${script.background || "故事自然演进中"}

你现在必须【完全代入并扮演角色：${nextActor.name}】。
扮演要求：
1. 严格以《${nextActor.name}》的视角、语气和性格回复。
2. 格式规范（三色排版）：
   - 动作描写用圆括号：（动作或环境细节）
   - 对白台词用双引号：“台词内容”
   - 心理活动用方括号：【内心独白】
3. 紧扣上一幕的情节，自然推动戏剧冲突与角色互动。不要输出其他角色的台词。`;

      const messagesPayload = [
        { role: "system", content: systemPrompt },
        ...script.turns.slice(-10).map((t) => ({
          role: t.senderType === "user" ? "user" : "assistant",
          content: `[${t.senderName}]: ${t.content}`,
        })),
      ];

      // ── 走绑定桥：从「设置 → API 配置」取真实配置，替换原来的 /api/chat 野路子 ──
      const apiConfig = resolveEnsembleApiConfig(nextActor.id);
      if (!apiConfig) {
        setApiError("尚未配置 API，请到「设置 → API 配置」添加一个可用模型");
        return;
      }
      setApiError(null);
      setLastModel(apiConfig.defaultModel || apiConfig.name || "未知模型");

      const result = await simpleLLMCall(apiConfig, messagesPayload, {
        temperature: 0.85,
        max_tokens: script.maxTokensPerTurn ?? 8192,
        label: `群像·${nextActor.name}`,
      });

      let replyContent = (result.content || "").trim();
      if (!replyContent) {
        const reason = result.error || "模型返回空内容";
        setApiError(reason);
        replyContent = `（${nextActor.name} 陷入了短暂的沉思，目光望向窗外）\n“我们接下来该怎么做？”`;
      }

      replyContent = replyContent.replace(new RegExp(`^\\[?${nextActor.name}\\]?[:：]?\\s*`), "").trim();

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
    } catch (e) {
      console.error("AI turn generation failed:", e);
    } finally {
      setIsGenerating(false);
    }
  };

  // 发送用户自身对话轮次
  const handleSendTurn = async (isNarration: boolean = false) => {
    if (!inputText.trim() || !currentScript) return;
    const text = inputText.trim();
    setInputText("");

    const newTurn: EnsembleTurn = {
      id: "turn_" + Date.now(),
      senderId: isNarration ? "narration" : activePersona?.id || currentUser?.name || "user",
      senderName: isNarration ? "旁白" : activePersona?.name || currentUser?.name || "你",
      senderType: isNarration ? "narration" : "user",
      content: text,
      timestamp: new Date().toISOString(),
      tokens: Math.ceil(text.length * 1.3),
    };

    const updated = appendEnsembleTurn(currentScript.id, newTurn);
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
      await triggerAiTurn(updated);
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
      <div className="flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
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

        {/* 标签切换 */}
        <div className="flex items-center px-4 pt-3 pb-2 border-b border-black/[0.04] bg-white/40 gap-4 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab("my_ensembles")}
            className={`flex items-center gap-1.5 pb-2 text-xs font-semibold tracking-wide border-b-2 transition-all ${
              activeTab === "my_ensembles"
                ? "border-[#1a1a1a] text-[#1a1a1a]"
                : "border-transparent text-black/40 hover:text-black/60"
            }`}
          >
            <Users size={14} />
            我的剧本
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("discover")}
            className={`flex items-center gap-1.5 pb-2 text-xs font-semibold tracking-wide border-b-2 transition-all ${
              activeTab === "discover"
                ? "border-[#1a1a1a] text-[#1a1a1a]"
                : "border-transparent text-black/40 hover:text-black/60"
            }`}
          >
            <Compass size={14} />
            探索群像
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {activeTab === "discover" ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
              <Compass size={36} className="stroke-[1.5]" />
              <div className="text-sm">探索广场即将开放</div>
            </div>
          ) : visibleScripts.length === 0 ? (
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
                        deleteEnsembleScript(s.id);
                        setScripts(loadEnsembleScripts());
                      }}
                      className="p-1 rounded hover:text-red-500 text-black/25"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {s.background && (
                  <div className="text-xs text-black/50 line-clamp-2 leading-relaxed">
                    {s.background}
                  </div>
                )}
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
            <label className="text-xs font-semibold text-black/60 block mb-1.5">
              故事背景设定（可选）
            </label>
            <textarea
              value={bgInput}
              onChange={(e) => setBgInput(e.target.value)}
              placeholder="简要描述发生的时间、地点、核心冲突..."
              rows={3}
              className="w-full bg-black/[0.03] border border-black/5 rounded-xl px-3 py-2.5 text-xs text-[#1a1a1a] outline-none focus:border-black/20 resize-none"
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
    <div className="flex flex-col h-full relative bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
      {!currentScript ? (
        /* 兜底：剧本意外丢失时也不能变成"回不去的白屏" */
        <EnsembleHeader title="群像剧" onBack={(e?: any) => handleBack(e)} />
      ) : (
        <>
          <EnsembleHeader
            title={currentScript.title}
            subtitle={`${currentScript.cast.length} CAST${
              activePersona ? ` · ${activePersona.name}` : ""
            }`}
            onBack={(e?: any) => handleBack(e)}
          />

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
          >
            {apiError && (
              <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 leading-relaxed">
                API 调用失败：{apiError}
              </div>
            )}

            {currentScript.turns.length === 0 && !isGenerating && (
              <div className="flex flex-col items-center justify-center h-56 text-center text-black/35 space-y-2">
                <Play size={28} className="stroke-[1.5]" />
                <div className="text-xs">剧本已就绪，开始第一幕吧</div>
              </div>
            )}

            {currentScript.turns.map((turn) => {
              const isUser = turn.senderType === "user";
              const castChar = currentScript.cast.find((c) => c.id === turn.senderId);

              return (
                <div
                  key={turn.id}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-black/[0.03] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-black/10 overflow-hidden flex items-center justify-center text-xs font-semibold">
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

                  <TriColorText raw={turn.content} prefix={isUser ? "u" : undefined} />

                  <div className="flex items-center justify-between pt-2 border-t border-black/[0.03] text-[10px] text-black/35 font-mono">
                    <div className="flex items-center gap-3">
                      <span>DATE {turn.timestamp.slice(0, 10)}</span>
                      {(turn.model || lastModel) && (
                        <span className="truncate max-w-[140px]" title={turn.model || lastModel}>
                          MODEL {turn.model || lastModel}
                        </span>
                      )}
                      {turn.tokens !== undefined && <span>TOKENS {turn.tokens}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const updated = deleteEnsembleTurn(currentScript.id, turn.id);
                        if (updated) {
                          setCurrentScript(updated);
                          setScripts(loadEnsembleScripts());
                        }
                      }}
                      className="p-1 hover:text-red-500 opacity-60"
                      title="删除本幕"
                    >
                      <Trash2 size={12} />
                    </button>
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
            <div className="flex items-center justify-between px-1 mb-2 text-black/45">
              <button
                type="button"
                onClick={() => triggerAiTurn(currentScript)}
                disabled={isGenerating}
                className="p-1.5 hover:bg-black/[0.04] rounded-lg disabled:opacity-40"
                title="继续推进"
              >
                <Play size={16} />
              </button>
              <div className="text-[10px] font-mono bg-black/[0.04] px-2 py-0.5 rounded-full">
                {currentScript.turns.length} 幕
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setNarrationSettingText(currentScript.background || "");
                  setShowNarrationModal(true);
                }}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-colors shrink-0 ${
                  currentScript.background?.trim()
                    ? "bg-amber-100 text-amber-800 border border-amber-300"
                    : "bg-black/[0.04] hover:bg-black/[0.07] text-black/50"
                }`}
                title="设置旁白与背景设定"
              >
                旁白
              </button>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendTurn(false);
                  }
                }}
                placeholder={activePersona ? `以「${activePersona.name}」发言...` : "Write your line..."}
                className="flex-1 min-w-0 bg-black/[0.03] border-none outline-none rounded-xl px-3 py-2 text-xs text-[#1a1a1a] placeholder:text-black/25"
              />
              <button
                type="button"
                disabled={!inputText.trim() || isGenerating}
                onClick={() => handleSendTurn(false)}
                className="p-2 bg-[#1a1a1a] text-white rounded-xl disabled:opacity-40 transition-opacity shrink-0"
              >
                <Send size={15} />
              </button>
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
        </>
      )}
    </div>
  );
}
