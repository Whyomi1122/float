"use client";

/**
 * 聊天室「检查挂件」。
 *
 * 目的：不用等实机截图猜，随时点开就能看清这一间聊天室到底带了什么进来 ——
 * 是不是剧情对话段、模型原始回包长什么样、清洗前后差在哪、上下文抽了多少条。
 *
 * 只读，不写任何业务数据。
 */

import { useEffect, useMemo, useState } from "react";
import {
    getDebugRawReply,
    getDebugRawReplyHistory,
    subscribeDebugRawReply,
    type DebugRawReply,
} from "@/lib/debug-store";
import {
    findOpenSession,
    loadDeliverySessions,
    loadSessionTranscript,
    sanitizeChatLine,
} from "@/lib/ensemble-delivery";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";

type Props = {
    session: ChatSession | null;
    messages: ChatMessage[];
    /** 当前角色名（单聊时有） */
    characterName?: string | null;
    /** 是否为群聊 */
    isGroup: boolean;
    /** 只在剧情对话段里出现，普通聊天不打扰 */
    enabled?: boolean;
};

type Tab = "context" | "raw" | "diff";

export function ChatInspectWidget({ session, messages, characterName, isGroup, enabled }: Props) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>("context");
    const [tick, setTick] = useState(0);

    useEffect(() => subscribeDebugRawReply(() => setTick(t => t + 1)), []);

    const rawReply = useMemo<DebugRawReply | null>(() => {
        void tick;
        return getDebugRawReply();
    }, [tick]);
    const history = useMemo(() => {
        void tick;
        return getDebugRawReplyHistory();
    }, [tick]);

    /** 本会话是不是剧情对话段，以及是哪一段。 */
    const delivery = useMemo(() => {
        if (!session) return null;
        const sessions = loadDeliverySessions();
        const hit = sessions.find(s => s.chatSessionId === session.id);
        if (!hit) return null;
        const transcript = loadSessionTranscript(hit.id)[0];
        return {
            session: hit,
            count: transcript?.messages.length ?? 0,
            open: !hit.endedAt,
        };
    }, [session?.id, messages.length]);

    /** 当前会话里带剧情标记的消息数。 */
    const tagged = useMemo(
        () => messages.filter(m => !!m.deliverySessionId).length,
        [messages],
    );

    const isStory = !!delivery;

    if (!session) return null;
    // 只在剧情对话段里出现：普通聊天不需要这个挂件，别干扰日常使用
    if (!isStory && !enabled) return null;

    return (
        <>
            {/* 小挂件本体：右上角一颗半透明圆点，不抢视线 */}
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-label="检查这间聊天室带了什么"
                className="fixed z-[70] flex items-center justify-center rounded-full transition-opacity"
                style={{
                    top: "calc(env(safe-area-inset-top, 0px) + 62px)",
                    right: 14,
                    width: 26,
                    height: 26,
                    background: isStory ? "rgba(34,120,80,0.14)" : "rgba(0,0,0,0.06)",
                    border: isStory
                        ? "1px solid rgba(34,120,80,0.35)"
                        : "1px solid rgba(0,0,0,0.10)",
                    color: isStory ? "rgba(24,110,70,0.85)" : "rgba(0,0,0,0.35)",
                    fontSize: 11,
                    fontWeight: 600,
                    opacity: open ? 1 : 0.75,
                }}
            >
                {isStory ? "剧" : "查"}
            </button>

            {open && (
                <div
                    className="fixed inset-0 z-[71] flex items-center justify-center px-4"
                    style={{ background: "rgba(0,0,0,0.32)" }}
                    onClick={() => setOpen(false)}
                >
                    <div
                        className="w-full max-w-[420px] max-h-[76vh] rounded-[18px] bg-white overflow-hidden flex flex-col"
                        style={{ boxShadow: "0 18px 48px rgba(0,0,0,0.22)" }}
                        onClick={e => e.stopPropagation()}
                    >
                        {/* 标题 */}
                        <div className="px-4 pt-4 pb-2 shrink-0">
                            <div className="flex items-center justify-between">
                                <div className="text-[15px] font-semibold text-black/85">
                                    这间聊天室带了什么
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setOpen(false)}
                                    className="text-[12px] text-black/40 px-2 py-1 rounded-lg bg-black/[0.04]"
                                >
                                    关闭
                                </button>
                            </div>
                            <div className="mt-1 text-[11px] text-black/40">
                                {isGroup ? "群聊" : "单聊"}
                                {characterName ? ` · ${characterName}` : ""}
                                {isStory ? " · 剧情对话段" : " · 普通聊天"}
                            </div>
                        </div>

                        {/* 标签栏 */}
                        <div className="px-4 pb-2 flex gap-1.5 shrink-0">
                            {(
                                [
                                    { k: "context", t: "装载内容" },
                                    { k: "raw", t: "模型原样回包" },
                                    { k: "diff", t: "清洗对照" },
                                ] as { k: Tab; t: string }[]
                            ).map(item => (
                                <button
                                    key={item.k}
                                    type="button"
                                    onClick={() => setTab(item.k)}
                                    className="px-2.5 py-1.5 rounded-[8px] text-[11px]"
                                    style={
                                        tab === item.k
                                            ? { background: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.8)", fontWeight: 600 }
                                            : { color: "rgba(0,0,0,0.45)" }
                                    }
                                >
                                    {item.t}
                                </button>
                            ))}
                        </div>

                        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2.5">
                            {tab === "context" && (
                                <>
                                    <Row
                                        label="模式"
                                        value={isStory ? "剧情对话段（回复会清洗成微信格式）" : "普通聊天"}
                                        tone={isStory ? "good" : "plain"}
                                    />
                                    {(delivery?.session.originContent ?? "") ? (
                                        <div className="rounded-[12px] bg-black/[0.03] px-3 py-2.5">
                                            <div className="text-[11px] text-black/40 mb-1">
                                                从群像带回的台词
                                            </div>
                                            <div className="text-[13px] leading-[1.7] text-black/75 whitespace-pre-wrap break-words">
                                                {delivery?.session.originContent}
                                            </div>
                                        </div>
                                    ) : null}
                                    <Row label="消息总数" value={`${messages.length} 条`} />
                                    <Row
                                        label="带剧情标记的消息"
                                        value={tagged > 0 ? `${tagged} 条` : "0 条（尚未打标）"}
                                        tone={tagged > 0 ? "good" : "warn"}
                                    />
                                    <Row
                                        label="原始回包记录"
                                        value={rawReply ? `${history.length} 条（最近一次 ${new Date(rawReply.timestamp).toLocaleTimeString("zh-CN")}）` : "暂无"}
                                    />
                                    {delivery && (
                                        <>
                                            <Divider text="剧情对话段" />
                                            <Row label="剧本" value={delivery.session.scriptTitle} />
                                            <Row label="起点台词" value={delivery.session.originContent.slice(0, 60)} />
                                            <Row
                                                label="状态"
                                                value={delivery.open ? "进行中（未点返回剧情）" : "已归入剧情"}
                                                tone={delivery.open ? "warn" : "good"}
                                            />
                                            <Row label="已记录聊天" value={`${delivery.count} 句`} />
                                            <Row
                                                label="开始于"
                                                value={new Date(delivery.session.startedAt).toLocaleString("zh-CN")}
                                            />
                                        </>
                                    )}
                                    {!delivery && (
                                        <div className="text-[11px] leading-relaxed text-black/45 bg-black/[0.03] rounded-[10px] px-3 py-2.5">
                                            这间不是剧情对话段。模型回复会原样显示，不做清洗。
                                            如果你是从群像投递过来的，说明会话关联没写进去 —— 这正是需要修的地方。
                                        </div>
                                    )}
                                    <Divider text="记忆 / 上下文" />
                                    <div className="text-[11px] leading-relaxed text-black/50 bg-black/[0.03] rounded-[10px] px-3 py-2.5">
                                        记忆注入与提示词全文请看「设置 → 工具 → 提示词查看器」，那里能看完整 system prompt。
                                        这里能看到的是这条消息回包前后的真实数据。
                                    </div>
                                </>
                            )}

                            {tab === "raw" && (
                                <>
                                    {!rawReply && (
                                        <Empty text="还没有模型回包记录。发一条消息再来看。" />
                                    )}
                                    {rawReply && (
                                        <>
                                            <Row label="时间" value={new Date(rawReply.timestamp).toLocaleString("zh-CN")} />
                                            <Row label="来源" value={rawReply.appId} />
                                            <Row label="备注" value={rawReply.note || "—"} />
                                            <Row label="角色" value={rawReply.characterName || "—"} />
                                            <Pre title="模型原样返回" text={rawReply.raw || "（空）"} />
                                            {rawReply.parts && rawReply.parts.length > 0 && (
                                                <Pre
                                                    title={`实际发出去的 ${rawReply.parts.length} 条`}
                                                    text={rawReply.parts.join("\n---\n")}
                                                />
                                            )}
                                        </>
                                    )}
                                </>
                            )}

                            {tab === "diff" && (
                                <>
                                    {!rawReply && <Empty text="还没有回包记录。" />}
                                    {rawReply && !rawReply.sanitized && (
                                        <Empty text="这一条不是剧情对话段，没有做清洗。" />
                                    )}
                                    {rawReply && rawReply.sanitized && (
                                        <>
                                            <Pre title="清洗前（模型原文）" text={rawReply.raw || "（空）"} tone="bad" />
                                            <Pre title="清洗后（发出去的样子）" text={rawReply.sanitized} tone="good" />
                                            <Pre
                                                title="这条消息现在显示的内容"
                                                text={
                                                    messages.length > 0
                                                        ? messages[messages.length - 1].content.slice(0, 600)
                                                        : "—"
                                                }
                                            />
                                            <div className="text-[11px] leading-relaxed text-black/45 bg-black/[0.03] rounded-[10px] px-3 py-2.5">
                                                三栏一致 = 清洗正常。若「清洗前」还带（动作）【心理】而「清洗后」还有残留，
                                                说明清洗规则没覆盖这种写法，把这句原文发我就能补规则。
                                            </div>
                                        </>
                                    )}
                                    {/* 即时试算：拿最后一条消息再洗一遍，验证规则 */}
                                    {messages.length > 0 && (
                                        <>
                                            <Divider text="规则自检（对最后一条消息）" />
                                            <Pre
                                                title="原文"
                                                text={messages[messages.length - 1].rawResponseText || messages[messages.length - 1].content}
                                            />
                                            <Pre
                                                title="再过一次清洗规则"
                                                text={sanitizeChatLine(
                                                    messages[messages.length - 1].rawResponseText ||
                                                        messages[messages.length - 1].content,
                                                )}
                                                tone="good"
                                            />
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function Row({
    label,
    value,
    tone = "plain",
}: {
    label: string;
    value: string;
    tone?: "plain" | "good" | "warn";
}) {
    const color =
        tone === "good"
            ? "rgba(24,110,70,0.85)"
            : tone === "warn"
              ? "rgba(160,90,20,0.85)"
              : "rgba(0,0,0,0.72)";
    return (
        <div className="flex items-start gap-3 text-[12px] leading-relaxed">
            <span className="shrink-0 w-[92px] text-black/40">{label}</span>
            <span className="flex-1 min-w-0 break-words" style={{ color }}>
                {value}
            </span>
        </div>
    );
}

function Divider({ text }: { text: string }) {
    return (
        <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-black/30 tracking-[0.1em]">{text}</span>
            <span className="flex-1 h-px bg-black/[0.07]" />
        </div>
    );
}

function Pre({
    title,
    text,
    tone = "plain",
}: {
    title: string;
    text: string;
    tone?: "plain" | "good" | "bad";
}) {
    const bg =
        tone === "good"
            ? "rgba(34,120,80,0.06)"
            : tone === "bad"
              ? "rgba(180,60,40,0.05)"
              : "rgba(0,0,0,0.035)";
    return (
        <div>
            <div className="text-[10px] text-black/35 mb-1">{title}</div>
            <div
                className="rounded-[10px] px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto"
                style={{ background: bg, color: "rgba(0,0,0,0.72)" }}
            >
                {text || "（空）"}
            </div>
        </div>
    );
}

function Empty({ text }: { text: string }) {
    return (
        <div className="text-[11px] leading-relaxed text-black/45 bg-black/[0.03] rounded-[10px] px-3 py-3">
            {text}
        </div>
    );
}
