// lib/debug-store.ts
// Lightweight global store: ChatRoom writes current session+messages, DebugPromptPanel reads.

import type { ChatSession, ChatMessage } from "./chat-storage";
import type { LLMContentPart } from "./llm-prompt-assembler";

export type DebugChatState = { session: ChatSession; messages: ChatMessage[] } | null;
export type DebugPromptSnapshot = {
    id: string;
    timestamp: string;
    requestKind: "completion" | "native-tools" | "native-tools-stream";
    provider: string;
    providerKind: string;
    model: string;
    appId: string;
    appTags?: string[];
    sessionId?: string;
    characterName?: string;
    presetName?: string;
    messages: { role: string; content: string | LLMContentPart[]; marker?: string }[];
    tools?: { name: string; description?: string }[];
};

let _state: DebugChatState = null;
const _listeners = new Set<() => void>();
let _promptSnapshot: DebugPromptSnapshot | null = null;
const _promptListeners = new Set<() => void>();

export function setDebugChatState(s: DebugChatState): void {
    _state = s;
    _listeners.forEach(fn => fn());
}

export function getDebugChatState(): DebugChatState {
    return _state;
}

export function subscribeDebugChatState(fn: () => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

export function setDebugPromptSnapshot(snapshot: DebugPromptSnapshot): void {
    _promptSnapshot = snapshot;
    _promptListeners.forEach(fn => fn());
}

export function getDebugPromptSnapshot(): DebugPromptSnapshot | null {
    return _promptSnapshot;
}

export function subscribeDebugPromptSnapshot(fn: () => void): () => void {
    _promptListeners.add(fn);
    return () => { _promptListeners.delete(fn); };
}

/**
 * 最近一次模型「原始回包」记录。
 *
 * 为什么需要它：提示词快照只能看到发出去的是什么，
 * 而「模型吐出来的台词里混着（动作）【心理】」这类问题，
 * 必须对照原始输出才能判断是模型写脏了、还是清洗没生效。
 */
export type DebugRawReply = {
    timestamp: string;
    /** 哪个 App 发起的请求（chat / ensemble …） */
    appId: string;
    sessionId?: string;
    characterName?: string;
    model: string;
    /** 模型原样返回的文本（未经任何清洗） */
    raw: string;
    /** 清洗成聊天格式之后的文本（非聊天场景为空） */
    sanitized?: string;
    /** 被拆成几条消息发出去 */
    parts?: string[];
    /** 本次请求的备注，比如「剧情对话段 · 已开启清洗」 */
    note?: string;
};

let _rawReply: DebugRawReply | null = null;
const _rawReplyListeners = new Set<() => void>();
/** 保留最近 10 条，方便对比几轮的变化 */
const _rawReplyHistory: DebugRawReply[] = [];
let _rawReplyTick = 0;

export function setDebugRawReply(reply: DebugRawReply): void {
    _rawReply = reply;
    _rawReplyHistory.unshift(reply);
    if (_rawReplyHistory.length > 10) _rawReplyHistory.length = 10;
    _rawReplyTick += 1;
    _rawReplyListeners.forEach(fn => fn());
}

export function getDebugRawReply(): DebugRawReply | null {
    return _rawReply;
}

export function getDebugRawReplyHistory(): DebugRawReply[] {
    return _rawReplyHistory;
}

export function subscribeDebugRawReply(fn: () => void): () => void {
    _rawReplyListeners.add(fn);
    return () => { _rawReplyListeners.delete(fn); };
}

export function getDebugRawReplyTick(): number {
    return _rawReplyTick;
}
