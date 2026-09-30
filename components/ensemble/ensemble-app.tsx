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
} from "lucide-react";
import { Character, ChatMessage } from "@/types";
import {
  EnsembleScript,
  EnsembleTurn,
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
} from "@/lib/ensemble-storage";

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

interface EnsembleAppProps {
  characters: Character[];
  currentUser?: { name: string; avatar?: string };
  onBack?: () => void;
}

export function EnsembleApp({
  characters = [],
  currentUser,
  onBack,
}: EnsembleAppProps) {
  const [scripts, setScripts] = useState<EnsembleScript[]>([]);
  const [currentScript, setCurrentScript] = useState<EnsembleScript | null>(null);
  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [activeTab, setActiveTab] = useState<"my_ensembles" | "discover">("my_ensembles");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const [titleInput, setTitleInput] = useState("");
  const [bgInput, setBgInput] = useState("");
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showNarrationModal, setShowNarrationModal] = useState(false);
  const [narrationSettingText, setNarrationSettingText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setScripts(loadEnsembleScripts());
  }, []);

  useEffect(() => {
    if (currentScript) {
      setNarrationSettingText(currentScript.background || "");
    }
  }, [currentScript?.id]);

  useEffect(() => {
    if (view === "detail" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentScript?.turns?.length, isGenerating, view]);

  // 新建剧本
  const handleCreateScript = () => {
    if (!titleInput.trim()) return;
    const chosenChars = characters.filter((c) => selectedCastIds.includes(c.id));
    const newScript: EnsembleScript = {
      id: "ens_" + Date.now(),
      title: titleInput.trim(),
      background: bgInput.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cast: chosenChars.map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        persona: c.systemPrompt || c.description || "",
      })),
      turns: [],
    };
    saveOrUpdateEnsembleScript(newScript);
    setScripts(loadEnsembleScripts());
    setCurrentScript(newScript);
    setTitleInput("");
    setBgInput("");
    setSelectedCastIds([]);
    setView("detail");
  };

  // 触发 AI 生成下一个轮次
  const triggerAiTurn = async (script: EnsembleScript) => {
    if (isGenerating || !script.cast || script.cast.length === 0) return;
    setIsGenerating(true);
    try {
      // 决定下一个发言角色
      const lastTurn = script.turns[script.turns.length - 1];
      let nextActor = script.cast[0];
      if (lastTurn) {
        const otherActors = script.cast.filter((c) => c.id !== lastTurn.senderId);
        if (otherActors.length > 0) {
          nextActor = otherActors[Math.floor(Math.random() * otherActors.length)];
        }
      }

      // 构建系统提示词
      const castDesc = script.cast
        .map((c) => `- ${c.name}: ${c.persona || "暂无特别设定"}`)
        .join("\n");

      const systemPrompt = `你正在参与一场名为《${script.title}》的群像互动剧本。
当前参演角色阵容：
${castDesc}

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
        ...(script.turns || []).slice(-10).map((t) => ({
          role: t.senderType === "user" ? "user" : "assistant",
          content: `[${t.senderName}]: ${t.content}`,
        })),
      ];

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messagesPayload,
          stream: false,
        }),
      });

      let replyContent = "";
      if (res.ok) {
        const data = await res.json();
        replyContent = data.content || data.reply || data.choices?.[0]?.message?.content || "";
      } else {
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
      };

      const updatedScript: EnsembleScript = {
        ...script,
        turns: [...(script.turns || []), nextTurn],
        updatedAt: new Date().toISOString(),
      };

      saveOrUpdateEnsembleScript(updatedScript);
      setCurrentScript(updatedScript);
      setScripts(loadEnsembleScripts());
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
      senderId: isNarration ? "narration" : currentUser?.name || "user",
      senderName: isNarration ? "旁白" : currentUser?.name || "你",
      senderType: isNarration ? "narration" : "user",
      content: text,
      timestamp: new Date().toISOString(),
      tokens: Math.ceil(text.length * 1.3),
    };

    const updatedScript: EnsembleScript = {
      ...currentScript,
      turns: [...(currentScript.turns || []), newTurn],
      updatedAt: new Date().toISOString(),
    };

    saveOrUpdateEnsembleScript(updatedScript);
    setCurrentScript(updatedScript);
    setScripts(loadEnsembleScripts());
    await triggerAiTurn(updatedScript);
  };

  return (
    <div className="flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans select-none overflow-hidden">
      {/* 视图 1：剧本列表 */}
      {view === "list" && (
        <div className="flex flex-col h-full">
          {/* 顶栏 */}
          <div className="h-14 border-b border-black/[0.06] flex items-center justify-between px-4 bg-white/70 backdrop-blur-md">
            <div className="flex items-center gap-2">
              {onBack && (
                <button
                  onClick={onBack}
                  className="p-2 -ml-2 rounded-full hover:bg-black/5 text-black/60"
                >
                  <ChevronLeft size={20} />
                </button>
              )}
              <h1 className="text-[17px] font-semibold tracking-tight">群像剧</h1>
            </div>
            <button
              onClick={() => setView("create")}
              className="p-2 -mr-2 rounded-full hover:bg-black/5 text-black/70 flex items-center gap-1 text-sm font-medium"
            >
              <Plus size={20} />
            </button>
          </div>

          {/* 标签切换 */}
          <div className="flex items-center px-4 pt-3 pb-2 border-b border-black/[0.04] bg-white/40 gap-4">
            <button
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

          {/* 列表内容 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {scripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
                <Users size={36} className="stroke-[1.5]" />
                <div className="text-sm">暂无群像剧</div>
                <button
                  onClick={() => setView("create")}
                  className="px-4 py-2 bg-[#1a1a1a] text-white rounded-xl text-xs font-medium shadow-sm active:scale-95 transition"
                >
                  创建第一个群像剧
                </button>
              </div>
            ) : (
              scripts.map((s) => (
                <div
                  key={s.id}
                  onClick={() => {
                    setCurrentScript(s);
                    setView("detail");
                  }}
                  className="bg-white/80 backdrop-blur-sm border border-black/[0.04] rounded-2xl p-4 shadow-sm active:scale-[0.99] transition Antigravity-pointer flex flex-col gap-2.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm text-[#1a1a1a] line-clamp-1">
                      {s.title}
                    </div>
                    <div className="text-[10px] text-black/40 font-mono">
                      {s.cast?.length || 0} CAST
                    </div>
                  </div>
                  {s.background && (
                    <div className="text-xs text-black/50 line-clamp-2 leading-relaxed">
                      {s.background}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1 border-t border-black/[0.02]">
                    <div className="flex -space-x-1.5 overflow-hidden">
                      {(s.cast || []).map((c) => (
                        <div
                          key={c.id}
                          className="w-5 h-5 rounded-full border border-white bg-black/10 overflow-hidden flex items-center justify-center text-[8px]"
                        >
                          {c.avatar ? (
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
                      {s.turns?.length || 0} 幕
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 视图 2：创建剧本 */}
      {view === "create" && (
        <div className="flex flex-col h-full bg-white">
          <div className="h-14 border-b border-black/[0.06] flex items-center justify-between px-4">
            <button
              onClick={() => setView("list")}
              className="p-2 -ml-2 rounded-full hover:bg-black/5 text-black/60"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="text-sm font-semibold">新建群像剧</div>
            <button
              disabled={!titleInput.trim() || selectedCastIds.length === 0}
              onClick={handleCreateScript}
              className="text-xs font-semibold text-[#1a1a1a] disabled:opacity-30"
            >
              完成
            </button>
          </div>

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
              <div className="grid grid-cols-2 gap-2">
                {characters.map((c) => {
                  const isSelected = selectedCastIds.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        setSelectedCastIds((prev) =>
                          isSelected
                            ? prev.filter((id) => id !== c.id)
                            : [...prev, c.id]
                        );
                      }}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border transition Antigravity-pointer ${
                        isSelected
                          ? "border-[#1a1a1a] bg-black/[0.04]"
                          : "border-black/5 bg-black/[0.01]"
                      }`}
                    >
                      <div className="w-8 h-8 rounded-full bg-black/10 overflow-hidden flex items-center justify-center text-xs">
                        {c.avatar ? (
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
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 视图 3：剧本剧场（详情对话） */}
      {view === "detail" && currentScript && (
        <div className="flex flex-col h-full relative">
          {/* 顶栏 */}
          <div className="h-14 border-b border-black/[0.06] flex items-center justify-between px-4 bg-white/80 backdrop-blur-md shrink-0">
            <button
              onClick={() => setView("list")}
              className="p-2 -ml-2 rounded-full hover:bg-black/5 text-black/60"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="flex flex-col items-center max-w-[200px]">
              <div className="text-sm font-semibold truncate">
                {currentScript.title}
              </div>
              <div className="text-[10px] text-black/40 font-mono">
                {currentScript.cast?.length || 0} CAST
              </div>
            </div>
            <div className="flex items-center -space-x-1.5">
              {(currentScript.cast || []).slice(0, 3).map((c) => (
                <div
                  key={c.id}
                  className="w-6 h-6 rounded-full border-2 border-white bg-black/10 overflow-hidden"
                >
                  {c.avatar && (
                    <img
                      src={c.avatar}
                      alt={c.name}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 剧幕内容区 */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
          >
            {(currentScript.turns || []).map((turn) => {
              const isUser = turn.senderType === "user";
              const isNarration = turn.senderType === "narration";
              const castChar = currentScript.cast?.find((c) => c.id === turn.senderId);

              return (
                <div
                  key={turn.id}
                  className="bg-white rounded-2xl p-4 shadow-sm border border-black/[0.03] space-y-3"
                >
                  {/* 角色信息头部 */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-black/10 overflow-hidden flex items-center justify-center text-xs font-semibold">
                        {castChar?.avatar ? (
                          <img
                            src={castChar.avatar}
                            alt={turn.senderName}
                            className="w-full h-full object-cover"
                          />
                        ) : isUser ? (
                          currentUser?.avatar ? (
                            <img
                              src={currentUser.avatar}
                              alt="Me"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            "你"
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

                  {/* 对话正文：三色优雅排版 */}
                  <TriColorText
                    raw={turn.content}
                    prefix={isUser ? "u" : undefined}
                  />

                  {/* 底部元数据 */}
                  <div className="flex items-center justify-between pt-2 border-t border-black/[0.03] text-[10px] text-black/35 font-mono">
                    <div className="flex items-center gap-3">
                      <span>DATE {turn.timestamp.slice(0, 10)}</span>
                      {turn.tokens !== undefined && <span>TOKENS {turn.tokens}</span>}
                    </div>
                    <div className="flex items-center gap-1.5 opacity-60">
                      <button
                        onClick={() => {
                          const updatedScript: EnsembleScript = {
                            ...currentScript,
                            turns: currentScript.turns.filter((t) => t.id !== turn.id),
                            updatedAt: new Date().toISOString(),
                          };
                          saveOrUpdateEnsembleScript(updatedScript);
                          setCurrentScript(updatedScript);
                          setScripts(loadEnsembleScripts());
                        }}
                        className="p-1 hover:text-red-500"
                        title="删除本幕"
                      >
                        <Trash2 size={12} />
                      </button>
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
                onClick={() => {
                  setNarrationSettingText(currentScript.background || "");
                  setShowNarrationModal(true);
                }}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-colors ${
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

          {/* 旁白与场景设定弹窗 */}
          {showNarrationModal && (
            <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl w-full max-w-sm p-4 shadow-xl border border-black/5 flex flex-col gap-3">
                <div className="flex items-center justify-between pb-2 border-b border-black/5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-[#1a1a1a]">
                      旁白与场景设定
                    </span>
                  </div>
                  <button
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
                    onClick={() => {
                      setNarrationSettingText("");
                      const updated = { ...currentScript, background: "" };
                      saveOrUpdateEnsembleScript(updated);
                      setCurrentScript(updated);
                      setScripts(loadEnsembleScripts());
                      setShowNarrationModal(false);
                    }}
                    className="px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg"
                  >
                    清空
                  </button>
                  <button
                    onClick={() => {
                      const updated = {
                        ...currentScript,
                        background: narrationSettingText.trim(),
                      };
                      saveOrUpdateEnsembleScript(updated);
                      setCurrentScript(updated);
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
        </div>
      )}
    </div>
  );
}
