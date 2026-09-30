"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft, MoreHorizontal, Play, Zap, FileText, Link as LinkIcon, Send, Trash2, Edit3, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { ChatMessage } from "@/lib/chat-storage";
import type { ChatCompletionCallbacks } from "@/lib/chat-engine";
import {
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  type EnsembleScript,
  type EnsembleTurn,
} from "@/lib/ensemble-storage";
import { resolveUserIdentity, loadUserIdentities } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
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
      timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
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

      // 1) 剧本历史 → 引擎要的 ChatMessage[]
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

      // 2) session 字段名必须匹配 group-chat-engine 的读取
      const dummySession: any = {
        id: script.id,
        participantIds: script.cast.map((c) => c.characterId),  // 引擎读 participantIds
        groupName: script.title,                                 // 引擎读 groupName
        isSpectator: false,
      };

      // 3) 收集本轮 AI 气泡
      const aiTurns: EnsembleTurn[] = [];

      // 4) 正确调用：第2参 ChatMessage[]，第3参回调对象
      const results = await generateGroupChatCompletion(
        dummySession,
        historyMessages,
        {
          onStreamDelta: () => { /* 预留：可在此实时预览 */ },
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
      );

      // 5) 兜底：引擎若没触发 onTextPart，用返回值构造
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
        <div className="flex flex-col h-full bg-[#f8f9fa] relative">
          <div className="pt-10 px-4 pb-3 bg-white/80 backdrop-blur-md border-b border-black/5 flex items-center justify-between z-10 shrink-0">
            <button
              type="button"
              onClick={handleBack}
              onTouchEnd={handleBack}
              className="w-12 h-12 -ml-3 flex items-center justify-center rounded-full active:bg-black/10 transition-colors text-neutral-800 touch-manipulation"
              aria-label="返回剧本列表"
            >
              <ChevronLeft size={28} />
            </button>
            <div className="flex flex-col items-center">
              <span className="font-bold text-sm tracking-tight text-neutral-800">{currentScript.title}</span>
              <span className="text-[10px] text-neutral-400 font-mono tracking-wider">{currentScript.cast.length} CAST</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="flex -space-x-1.5 overflow-hidden">
                {currentScript.cast.slice(0, 3).map((item) => {
                  const ch = characters.find((c) => c.id === item.characterId);
                  return (
                    <div key={item.characterId} className="inline-block h-6 w-6 rounded-full ring-2 ring-white overflow-hidden bg-neutral-200">
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

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {currentScript.turns.map((turn) => {
              const isUser = turn.senderType === "user";
              const isNarration = turn.senderType === "narration";
              return (
                <div
                  key={turn.id}
                  className={`bg-white rounded-2xl p-4 border border-black/5 shadow-sm relative ${
                    isUser ? "border-l-4 border-l-[#007aff]" : ""
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {turn.senderAvatar && (
                        <img src={turn.senderAvatar} alt="" className="w-8 h-8 rounded-full object-cover border border-neutral-100" />
                      )}
                      <div>
                        <span className="font-bold text-xs text-neutral-900">{turn.senderName}</span>
                        {isNarration && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-50 text-[10px] text-blue-500 font-medium">
                            NARRATION
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-sm text-neutral-800 leading-relaxed whitespace-pre-wrap font-sans my-2">
                    {turn.content}
                  </div>

                  <div className="mt-3 pt-2 border-t border-neutral-100 flex items-center justify-between text-[10px] text-neutral-400 font-mono">
                    <div>
                      <span>DATE {turn.timestamp}</span>
                      {turn.tokens && <span className="ml-3">TOKENS {turn.tokens}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="hover:text-neutral-600"><Edit3 size={13} /></button>
                      <button
                        onClick={() => {
                          const nextTurns = currentScript.turns.filter((t) => t.id !== turn.id);
                          const sc = { ...currentScript, turns: nextTurns };
                          setCurrentScript(sc);
                          saveOrUpdateEnsembleScript(sc);
                        }}
                        className="hover:text-red-500"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {isGenerating && (
              <div className="text-center py-3 text-xs text-neutral-400 animate-pulse">
                剧本演播推进中...
              </div>
            )}
          </div>

          <div className="bg-white/90 backdrop-blur-md border-t border-neutral-200/80 px-3 py-2 pb-6 shrink-0">
            <div className="flex items-center justify-between px-1 mb-2 text-neutral-600">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => triggerAiTurn(currentScript)}
                  disabled={isGenerating}
                  className="p-1.5 hover:bg-neutral-100 rounded-lg text-neutral-700 disabled:opacity-40"
                  title="继续推进"
                >
                  <Play size={16} />
                </button>
                <button className="p-1.5 hover:bg-neutral-100 rounded-lg text-neutral-700" title="剧情拐点">
                  <Zap size={16} />
                </button>
                <button className="p-1.5 hover:bg-neutral-100 rounded-lg text-neutral-700" title="剧本便签">
                  <FileText size={16} />
                </button>
                <button className="p-1.5 hover:bg-neutral-100 rounded-lg text-neutral-700" title="关联网络">
                  <LinkIcon size={16} />
                </button>
              </div>
              <div className="text-[10px] font-mono text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded-full">
                0 tk
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSendTurn(true)}
                className="px-2 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 rounded-xl text-[11px] font-semibold tracking-wide"
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
                className="flex-1 bg-neutral-100 border-none outline-none rounded-xl px-3 py-2 text-xs text-neutral-800 placeholder:text-neutral-400"
              />
              <button
                disabled={!inputText.trim() || isGenerating}
                onClick={() => handleSendTurn(false)}
                className="p-2 bg-[#007aff] text-white rounded-xl disabled:opacity-40 transition-opacity"
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
