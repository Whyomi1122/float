"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, MoreHorizontal, Plus, Play, Zap, FileText, Link as LinkIcon, Send, Trash2, Edit3, X, Users } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  loadEnsemblePersonas,
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  type EnsemblePersona,
  type EnsembleScript,
  type EnsembleTurn,
} from "@/lib/ensemble-storage";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";
import { resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";

type EnsembleAppProps = {
  onClose: () => void;
};

export function EnsembleApp({ onClose }: EnsembleAppProps) {
  // 视图状态: "personas" (选皮) | "scripts" (选剧本/选角) | "workspace" (演播厅)
  const [view, setView] = useState<"personas" | "scripts" | "workspace">("personas");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [personas, setPersonas] = useState<EnsemblePersona[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<EnsemblePersona | null>(null);

  const [scripts, setScripts] = useState<EnsembleScript[]>([]);
  const [currentScript, setCurrentScript] = useState<EnsembleScript | null>(null);

  // 演播厅输入与生成状态
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<"my_ensembles" | "new_cast">("my_ensembles");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCharacters(loadCharacters());
    setPersonas(loadEnsemblePersonas());
    setScripts(loadEnsembleScripts());
  }, []);

  useEffect(() => {
    if (view === "workspace" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentScript?.turns.length, view]);

  // 选择 Persona
  const handleSelectPersona = (p: EnsemblePersona) => {
    setSelectedPersona(p);
    setView("scripts");
  };

  // 创建新剧本进入演播室
  const handleStartNewScript = () => {
    if (!selectedPersona || selectedCastIds.length === 0) return;
    const newScript: EnsembleScript = {
      id: "script_" + Date.now(),
      title: "新群像剧本",
      personaId: selectedPersona.id,
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

  // 进入已有剧本
  const handleOpenScript = (script: EnsembleScript) => {
    setCurrentScript(script);
    setView("workspace");
  };

  // 发送玩家行动/旁白
  const handleSendTurn = async (forcedNarration = false) => {
    if (!inputText.trim() || !currentScript || isGenerating) return;
    const text = inputText.trim();
    setInputText("");

    const userTurn: EnsembleTurn = {
      id: "turn_" + Date.now(),
      senderType: forcedNarration ? "narration" : "user",
      senderName: forcedNarration ? "旁白" : selectedPersona?.name || "你",
      content: text,
      timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
    };

    const updatedTurns = [...currentScript.turns, userTurn];
    const updatedScript = { ...currentScript, turns: updatedTurns };
    setCurrentScript(updatedScript);
    saveOrUpdateEnsembleScript(updatedScript);

    // 触发 AI 协同演算
    await triggerAiTurn(updatedScript);
  };

  // AI 推动演算
  const triggerAiTurn = async (script: EnsembleScript) => {
    if (isGenerating) return;
    setIsGenerating(true);

    try {
      // 组装群像上下文字符串
      const castCharacters = script.cast
        .map((c) => characters.find((ch) => ch.id === c.characterId))
        .filter(Boolean) as Character[];

      // 提取最近的对话与描写
      const historyContext = script.turns
        .slice(-10)
        .map((t) => `[${t.senderName}]: ${t.content}`)
        .join("\n\n");

      // 构造群像小说推进专用 Prompt 指令
      const ensembleDirective = `
【群像剧情演播室 - 小说叙事要求】
你正在协同创作一部群像小说。
当前在场角色：${castCharacters.map((c) => c.name).join("、")}。
玩家设定身份：${selectedPersona?.name}（${selectedPersona?.identityTag || "无"}）。
请基于上述剧情进展，继续推动场景。每个角色的发言与动作需遵循其人设，重点展现肢体动作、心理活动与环境交互。
输出格式要求：按以下格式输出发言与旁白（可以同时包含多位角色的动作描写与对话）：
[角色名]: (动作与神态描写) 对白
`;

      // 借用 Float 原生的 group-chat 驱动
      const binding = resolveBinding();
      const firstChar = castCharacters[0];
      if (firstChar) {
        const dummySession: any = {
          id: script.id,
          type: "group",
          participantCharacterIds: script.cast.map((c) => c.characterId),
          name: script.title,
        };

        const replyRound = await generateGroupChatCompletion(
          dummySession,
          historyContext + "\n\n" + ensembleDirective,
          selectedPersona?.name || "你",
          () => {}
        );

        if (replyRound && replyRound.characterResponses) {
          const aiTurns: EnsembleTurn[] = replyRound.characterResponses.map((r, i) => {
            const charObj = characters.find((c) => c.id === r.characterId);
            return {
              id: "turn_ai_" + Date.now() + "_" + i,
              senderType: "character",
              senderId: r.characterId,
              senderName: charObj?.name || r.characterName,
              senderAvatar: charObj?.avatar,
              content: r.responseText,
              timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
              tokens: Math.round(r.responseText.length * 1.3),
            };
          });

          const finalScript = {
            ...script,
            turns: [...script.turns, ...aiTurns],
          };
          setCurrentScript(finalScript);
          saveOrUpdateEnsembleScript(finalScript);
        }
      }
    } catch (e) {
      console.error("[Ensemble] AI generation failed:", e);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f6f6f8] text-[#1c1c1e] select-none font-sans overflow-hidden">
      {/* 视图 1：Persona 选皮页（参考 Chill 图 3） */}
      {view === "personas" && (
        <div className="flex flex-col h-full p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-black/5">
              <ChevronLeft size={24} />
            </button>
            <div className="text-center">
              <h1 className="text-lg font-bold tracking-tight">Ensemble</h1>
              <p className="text-[10px] tracking-widest text-neutral-400 uppercase">Select Persona · 群像</p>
            </div>
            <div className="w-8" />
          </div>

          <div className="grid grid-cols-2 gap-3 pb-8">
            {personas.map((p, index) => (
              <div
                key={p.id}
                onClick={() => handleSelectPersona(p)}
                className="relative bg-white rounded-2xl p-3 border border-black/5 shadow-sm hover:shadow transition-all cursor-pointer flex flex-col justify-between h-[210px]"
              >
                <div className="w-full h-[120px] rounded-xl bg-neutral-100 flex items-center justify-center overflow-hidden">
                  {p.avatarUrl ? (
                    <img src={p.avatarUrl} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl text-neutral-300 font-serif">P</span>
                  )}
                  <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
                    0{index + 1}
                  </div>
                </div>
                <div className="mt-2">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">Persona</div>
                  <div className="font-bold text-sm text-neutral-800 flex items-center gap-1">
                    {p.name}
                    {p.identityTag && <span className="text-xs text-neutral-500 font-normal">（{p.identityTag}）</span>}
                  </div>
                  <div className="text-[10px] text-neutral-400 mt-0.5 line-clamp-1">{p.description || "群像主视角"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 视图 2：剧本列表与选角（参考 Chill 图 2） */}
      {view === "scripts" && selectedPersona && (
        <div className="flex flex-col h-full p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setView("personas")} className="p-2 -ml-2 rounded-full hover:bg-black/5">
              <ChevronLeft size={24} />
            </button>
            <div className="text-center">
              <h1 className="text-base font-bold">{selectedPersona.name} {selectedPersona.identityTag ? `（${selectedPersona.identityTag}）` : ""}</h1>
              <p className="text-[10px] tracking-widest text-neutral-400 uppercase">Group Story Workspace</p>
            </div>
            <div className="w-8" />
          </div>

          {/* 切换 Tab */}
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
              {scripts
                .filter((s) => s.personaId === selectedPersona.id)
                .map((s) => (
                  <div
                    key={s.id}
                    onClick={() => handleOpenScript(s)}
                    className="p-4 bg-white rounded-2xl border border-black/5 shadow-sm hover:shadow cursor-pointer flex justify-between items-center"
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
              {scripts.filter((s) => s.personaId === selectedPersona.id).length === 0 && (
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
                      className={`relative bg-white rounded-2xl p-3 border transition-all cursor-pointer flex flex-col justify-between h-[210px] ${
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

      {/* 视图 3：群像演播室 Workspace（参考 Chill 图 1） */}
      {view === "workspace" && currentScript && (
        <div className="flex flex-col h-full bg-[#f8f9fa] relative">
          {/* 顶部标题栏 */}
          <div className="px-4 py-3 bg-white/80 backdrop-blur-md border-b border-black/5 flex items-center justify-between z-10 shrink-0">
            <button onClick={() => setView("scripts")} className="p-1 -ml-1 rounded-full hover:bg-black/5">
              <ChevronLeft size={22} />
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
              <button className="p-1 rounded-full hover:bg-black/5 text-neutral-600">
                <MoreHorizontal size={18} />
              </button>
            </div>
          </div>

          {/* 小说式叙事消息流 */}
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

                  {/* 叙述文本 */}
                  <div className="text-sm text-neutral-800 leading-relaxed whitespace-pre-wrap font-sans my-2">
                    {turn.content}
                  </div>

                  {/* 底部元数据 */}
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

          {/* 底部工具条与输入框（参考 Chill 截图 1 底部） */}
          <div className="bg-white/90 backdrop-blur-md border-t border-neutral-200/80 px-3 py-2 shrink-0">
            {/* 顶排快捷指令 */}
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

            {/* 输入区 */}
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
