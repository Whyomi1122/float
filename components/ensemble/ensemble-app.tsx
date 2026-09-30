"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft, MoreHorizontal, Play, Send, Trash2, Edit3, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { ChatMessage } from "@/lib/chat-storage";

/** ISO / 中文格式都能显示 */
function formatTurnTime(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 三色配色（韩系灰，白天） */
const GS_COLORS = {
  dial: "#2b2b2b",   // 对白：深灰近黑
  act:  "#9b9691",   // 动作：暖灰
  inn:  "#a8895f",   // 内心：灰金
  rc:   "#b5b0aa",   // 收据/键值：浅灰
};

/** 把一段文本按 对白"" / 动作（） / 内心【】 切成带类型的片段 */
type TextSeg = { type: "dial" | "act" | "inn" | "plain"; text: string };
function parseTriColor(raw: string): TextSeg[] {
  const segs: TextSeg[] = [];
  // 依次匹配：【内心】、（动作）、"对白"
  const re = /【([^】]*)】|（([^）]*)）|"([^"]*)"|“([^”]*)”/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) segs.push({ type: "plain", text: raw.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ type: "inn", text: m[1] });
    else if (m[2] !== undefined) segs.push({ type: "act", text: m[2] });
    else if (m[3] !== undefined) segs.push({ type: "dial", text: m[3] });
    else if (m[4] !== undefined) segs.push({ type: "dial", text: m[4] });
    last = re.lastIndex;
  }
  if (last < raw.length) segs.push({ type: "plain", text: raw.slice(last) });
  return segs;
}

/** 渲染三色文本 */
function TriColorText({ raw, prefix }: { raw: string; prefix?: "u" }) {
  const segs = parseTriColor(raw);
  return (
    <div className="space-y-2 text-[15px] leading-relaxed">
      {segs.map((s, i) => {
        if (s.type === "plain") {
          // 处理空行与换行
          return <span key={i} className="whitespace-pre-wrap">{s.text}</span>;
        }
        const color =
          s.type === "dial" ? GS_COLORS.dial :
          s.type === "act"  ? GS_COLORS.act  :
                              GS_COLORS.inn;
        const wrap =
          s.type === "dial" ? `"${s.text}"` :
          s.type === "act"  ? `（${s.text}）` :
                              `【${s.text}】`;
        return (
          <span key={i} style={{ color }} className="inline whitespace-pre-wrap">
            {wrap}
          </span>
        );
      })}
    </div>
  );
}
import type { ChatCompletionCallbacks } from "@/lib/chat-engine";
import {
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  type EnsembleScript,
  type EnsembleTurn,
} from "@/lib/ensemble-storage";
import { resolveUserIdentity, loadUserIdentities, loadPresets } from "@/lib/settings-storage";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";

type EnsembleAppProps = {
  onClose: () => void;
};

export function EnsembleApp({ onClose }: EnsembleAppProps) {
  // v5.1：去掉了 "personas" 选皮页，直接进剧本列表
  const [view, setView] = useState<"scripts" | "workspace">("scripts");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeIdentity, setActiveIdentity] = useState<UserIdentity | null>(null);

  const [scripts, setScripts] = useState<EnsembleScript[]>([]);
  const [currentScript, setCurrentScript] = useState<EnsembleScript | null>(null);

  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<"my_ensembles" | "new_cast">("my_ensembles");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const all = loadCharacters();
    const ids = loadUserIdentities();
    const active = resolveUserIdentity();   // 当前激活面具（不传角色 = 全局默认）
    setActiveIdentity(active);
    setScripts(loadEnsembleScripts());

    // ★ 核心：只保留「绑定到当前激活面具」的角色
    const activeId = active?.id;
    const castable = activeId
      ? all.filter(ch => resolveUserIdentity(ch.id)?.id === activeId)
      : all;
    setCharacters(castable);

    // 若已有面具（ids 非空）但 active 为空，兜底取第一个
    if (!active && ids.length > 0) setActiveIdentity(ids[0]);
  }, []);

  useEffect(() => {
    if (view === "workspace" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentScript?.turns.length, view]);

  const handleBack = (e?: React.SyntheticEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (view === "workspace") setView("scripts");
    else if (typeof onClose === "function") onClose();
  };

  const handleStartNewScript = () => {
    if (!activeIdentity || selectedCastIds.length === 0) return;
    const newScript: EnsembleScript = {
      id: "script_" + Date.now(),
      title: `${activeIdentity.name}的群像剧`,
      personaId: activeIdentity.id,          // ← 真实面具 id
      cast: selectedCastIds.map((id) => ({ characterId: id })),
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxTokensPerTurn: 1000,
    };
    saveOrUpdateEnsembleScript(newScript);
    setScripts(loadEnsembleScripts());
    setCurrentScript(newScript);
    setView("workspace");
  };

  const handleSendTurn = async (forcedNarration = false) => {
    if (!inputText.trim() || !currentScript || isGenerating) return;
    const text = inputText.trim();
    setInputText("");

    const userTurn: EnsembleTurn = {
      id: "turn_" + Date.now(),
      senderType: forcedNarration ? "narration" : "user",
      senderName: forcedNarration ? "旁白" : (activeIdentity?.name || "你"),
      senderAvatar: forcedNarration ? undefined : activeIdentity?.avatarUrl,
      content: text,
      timestamp: new Date().toISOString(),
    };

    const updatedScript = { ...currentScript, turns: [...currentScript.turns, userTurn] };
    setCurrentScript(updatedScript);
    saveOrUpdateEnsembleScript(updatedScript);

    await triggerAiTurn(updatedScript);
  };

  // ⚠️ 注意：此函数在 v5.1.1a 中保留了旧的（签名错误的）调用形式，
  // 将在 v5.1.1b 用正确的 ChatMessage[] 调用替换。暂不影响 UI 验证。
  const triggerAiTurn = async (script: EnsembleScript) => {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const castCharacters = script.cast
        .map((c) => characters.find((ch) => ch.id === c.characterId))
        .filter(Boolean) as Character[];
      if (castCharacters.length === 0) return;

      const historyMessages: ChatMessage[] = script.turns.map((t, idx) => {
        const parsed = new Date(t.timestamp);
        return {
          id: t.id,
          sessionId: script.id,
          role: (t.senderType === "user" || t.senderType === "narration") ? "user" : "assistant",
          content: t.content,
          status: "sent",
          createdAt: isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString(),
          order: idx,
          senderName: t.senderName,
          senderCharacterId: t.senderId,
        };
      });

      const dummySession: any = {
        id: script.id,
        participantIds: script.cast.map((c) => c.characterId),
        groupName: script.title,
        isSpectator: false,
      };

      // 1. 获取群像专用预设
      const allPresets = loadPresets();
      const ensemblePreset =
        allPresets.find((p) => p.id === "ensemble_group_v1") ||
        allPresets.find((p) => p.name?.includes("群像") || (Array.isArray(p.tags) && p.tags.includes("ensemble")));

      const aiTurns: EnsembleTurn[] = [];
      const results = await generateGroupChatCompletion(
        dummySession,
        historyMessages,
        {
          onStreamDelta: () => {},
          onTextPart: (text, info) => {
            const charObj = characters.find((c) => c.id === info?.characterId);
            aiTurns.push({
              id: "turn_ai_" + Date.now() + "_" + aiTurns.length,
              senderType: "character",
              senderId: info?.characterId,
              senderName: info?.characterName || charObj?.name || "角色",
              senderAvatar: charObj?.avatar,
              content: text,
              timestamp: new Date().toISOString(),
              tokens: Math.round(text.length * 1.3),
            });
          },
        },
        {
          appTags: ["ensemble"],
          disableTools: true,
          promptProfile: ensemblePreset
            ? {
                presetId: ensemblePreset.id,
              }
            : undefined,
        }
      );

      if (aiTurns.length === 0 && Array.isArray(results)) {
        results.forEach((r, i) => {
          const charObj = characters.find((c) => c.id === r.characterId);
          aiTurns.push({
            id: "turn_ai_" + Date.now() + "_" + i,
            senderType: "character",
            senderId: r.characterId,
            senderName: charObj?.name || r.characterName,
            senderAvatar: charObj?.avatar,
            content: r.responseText,
            timestamp: new Date().toISOString(),
            tokens: Math.round(r.responseText.length * 1.3),
          });
        });
      }

      if (aiTurns.length > 0) {
        const finalScript = { ...script, turns: [...script.turns, ...aiTurns] };
        setCurrentScript(finalScript);
        saveOrUpdateEnsembleScript(finalScript);
        setScripts(loadEnsembleScripts());
      }
    } catch (e) {
      console.error("[Ensemble] AI generation failed:", e);
    } finally {
      setIsGenerating(false);
    }
  };
  // 兼容：老剧本 personaId 找不到对应面具时，回退到当前激活面具
  const belongsToActive = (s: EnsembleScript) =>
    activeIdentity ? s.personaId === activeIdentity.id : true;

  return (
    <div className="absolute inset-0 z-50 flex flex-col h-full bg-[#f6f6f8] text-[#1c1c1e] select-none font-sans overflow-hidden">
      {/* 视图：剧本列表与选角 */}
      {view === "scripts" && (
        <div className="flex flex-col h-full pt-10 px-4 pb-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={handleBack}
              onTouchEnd={handleBack}
              className="w-12 h-12 -ml-2 flex items-center justify-center rounded-full active:bg-black/10 transition-colors text-neutral-800 touch-manipulation"
              aria-label="返回桌面"
            >
              <ChevronLeft size={28} />
            </button>
            <div className="text-center">
              <h1 className="text-base font-bold">
                {activeIdentity?.name || "未设置面具"}
              </h1>
              <p className="text-[10px] tracking-widest text-neutral-400 uppercase">Group Story Workspace</p>
            </div>
            <div className="w-12" />
          </div>

          <div className="flex gap-2 my-4">
            <button
              onClick={() => setActiveTab("my_ensembles")}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "my_ensembles" ? "bg-white shadow-sm text-black border border-black/5" : "text-neutral-400"
              }`}
            >
              我的群像
            </button>
            <button
              onClick={() => setActiveTab("new_cast")}
              className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === "new_cast" ? "bg-[#1c1c1e] text-white" : "bg-neutral-100 text-neutral-400"
              }`}
            >
              选角 New Cast
            </button>
          </div>

          {activeTab === "my_ensembles" ? (
            <div className="space-y-3 pb-8">
              {scripts.filter(belongsToActive).map((s) => (
                <div
                  key={s.id}
                  onClick={() => { setCurrentScript(s); setView("workspace"); }}
                  className="p-4 bg-white rounded-2xl border border-black/5 shadow-sm hover:shadow Antigravity-pointer flex justify-between items-center"
                >
                  <div>
                    <h3 className="font-bold text-sm text-neutral-800">{s.title}</h3>
                    <p className="text-[11px] text-neutral-400 mt-1">
                      {s.cast.length} 位共演 · {s.turns.length} 幕
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteEnsembleScript(s.id);
                      setScripts(loadEnsembleScripts());
                    }}
                    className="p-2 text-neutral-400 hover:text-red-500 rounded-lg hover:bg-neutral-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {scripts.filter(belongsToActive).length === 0 && (
                <div className="text-center py-16 text-neutral-400 text-xs">
                  暂无群像剧本，点击上方「选角」开启第一幕
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col h-full">
              <div className="grid grid-cols-2 gap-3 pb-4">
                {characters.map((c, index) => {
                  const isSelected = selectedCastIds.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        setSelectedCastIds((prev) =>
                          isSelected ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                        );
                      }}
                      className={`relative bg-white rounded-2xl p-3 border transition-all Antigravity-pointer flex flex-col justify-between h-[210px] ${
                        isSelected ? "border-black shadow-md ring-2 ring-black/5" : "border-black/5 shadow-sm"
                      }`}
                    >
                      <div className="w-full h-[120px] rounded-xl bg-neutral-100 overflow-hidden relative">
                        {c.avatar ? (
                          <img src={c.avatar} alt={c.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-neutral-300 font-bold">
                            {c.name.slice(0, 1)}
                          </div>
                        )}
                        <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
                          0{index + 1}
                        </div>
                      </div>
                      <div className="mt-2">
                        <div className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">AI Node</div>
                        <div className="font-bold text-sm text-neutral-800">{c.name}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                disabled={selectedCastIds.length === 0}
                onClick={handleStartNewScript}
                className="w-full py-3 bg-[#1c1c1e] text-white rounded-2xl font-bold text-sm disabled:opacity-30 mt-auto mb-4"
              >
                开启群像演播室（已选 {selectedCastIds.length} 人）
              </button>
            </div>
          )}
        </div>
      )}

      {/* 视图：演播室 Workspace */}
      {view === "workspace" && currentScript && (
        <div className="flex flex-col h-full bg-[#f2f1ef] relative">
          {/* 顶栏：磨砂 + 圆角 */}
          <div className="pt-10 px-4 pb-3 bg-white/75 backdrop-blur-xl rounded-b-[18px] shadow-[0_1px_0_rgba(0,0,0,.04)] flex items-center justify-between z-10 shrink-0">
            <button
              type="button"
              onClick={handleBack}
              onTouchEnd={handleBack}
              className="w-12 h-12 -ml-3 flex items-center justify-center rounded-full active:bg-black/10 transition-colors text-neutral-800 touch-manipulation"
              aria-label="返回剧本列表"
            >
              <ChevronLeft size={28} />
            </button>
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-bold text-sm tracking-[2px] text-[#1a1a1a]">{currentScript.title}</span>
              <span className="text-[10px] text-black/20 font-mono tracking-wider">{currentScript.cast.length} CAST</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="flex -space-x-1.5 overflow-hidden">
                {currentScript.cast.slice(0, 3).map((item) => {
                  const ch = characters.find((c) => c.id === item.characterId);
                  return (
                    <div key={item.characterId} className="inline-block h-6 w-6 rounded-full ring-[1.5px] ring-white/90 overflow-hidden bg-neutral-200">
                      {ch?.avatar ? <img src={ch.avatar} alt={ch.name} className="h-full w-full object-cover" /> : null}
                    </div>
                  );
                })}
              </div>
              <button className="p-2 rounded-full hover:bg-black/5 text-neutral-600">
                <MoreHorizontal size={20} />
              </button>
            </div>
          </div>

          {/* 卡片区 */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {currentScript.turns.map((turn) => {
              const isUser = turn.senderType === "user";
              const isNarration = turn.senderType === "narration";
              return (
                <div
                  key={turn.id}
                  className={`rounded-2xl p-4 shadow-sm relative ${
                    isUser
                      ? "bg-black/[0.02] border border-dashed border-black/[0.08]"
                      : "bg-[#f6f5f3] border border-black/[0.04]"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {turn.senderAvatar && (
                        <img src={turn.senderAvatar} alt="" className="w-8 h-8 rounded-full object-cover border border-white/90" />
                      )}
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-[#1a1a1a] tracking-wide">{turn.senderName}</span>
                        {isNarration && (
                          <span className="px-1.5 py-0.5 rounded bg-black/[0.06] text-[10px] text-black/40 font-medium tracking-wider">
                            NARRATION
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-sm text-[#1a1a1a] leading-relaxed my-2">
                    <TriColorText raw={turn.content} />
                  </div>

                  <div className="mt-3 pt-2 border-t border-black/[0.05] flex items-center justify-between text-[10px] font-mono" style={{ color: GS_COLORS.rc }}>
                    <div>
                      <span>DATE {formatTurnTime(turn.timestamp)}</span>
                      {turn.tokens && <span className="ml-3">TOKENS {turn.tokens}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="hover:opacity-70"><Edit3 size={13} /></button>
                      <button
                        onClick={() => {
                          const nextTurns = currentScript.turns.filter((t) => t.id !== turn.id);
                          const sc = { ...currentScript, turns: nextTurns };
                          setCurrentScript(sc);
                          saveOrUpdateEnsembleScript(sc);
                        }}
                        className="hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {isGenerating && (
              <div className="text-center py-3 text-xs text-black/30 animate-pulse">
                剧本演播推进中...
              </div>
            )}
          </div>

          {/* 底部输入栏 */}
          <div className="bg-white/80 backdrop-blur-xl rounded-t-[18px] border-t border-black/[0.04] px-3 py-2 pb-6 shrink-0">
            <div className="flex items-center justify-between px-1 mb-2 text-black/45">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => triggerAiTurn(currentScript)}
                  disabled={isGenerating}
                  className="p-1.5 hover:bg-black/[0.04] rounded-lg disabled:opacity-40"
                  title="继续推进"
                >
                  <Play size={16} />
                </button>
              </div>
              <div className="text-[10px] font-mono bg-black/[0.04] px-2 py-0.5 rounded-full">
                0 tk
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSendTurn(true)}
                className="px-2 py-1.5 bg-black/[0.04] hover:bg-black/[0.07] text-black/50 rounded-xl text-[11px] font-semibold tracking-wide"
                title="作为旁白发出"
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
                placeholder="Write your line..."
                className="flex-1 bg-black/[0.03] border-none outline-none rounded-xl px-3 py-2 text-xs text-[#1a1a1a] placeholder:text-black/25"
              />
              <button
                disabled={!inputText.trim() || isGenerating}
                onClick={() => handleSendTurn(false)}
                className="p-2 bg-[#1a1a1a] text-white rounded-xl disabled:opacity-40 transition-opacity"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
