// lib/ensemble-delivery.ts
// 群像 ↔ 聊天 App 的「剧情对话段」搬运（2026-10-18 用户拍板）
//
// 模型：一段剧情对话 = 一次投递(起点) → 一次返回剧情(终点)。
//   · 投递时开启一段 session（带 scriptId / startTurnId / 起点时刻）
//   · 期间的聊天消息都打上这段 session 的标记
//   · 【返回剧情】时把整段打包成剧本的「来自聊天」记录，session 关闭
//   · 没点返回就直接走 → session 保持 open，群像里显示「有 N 段聊天未归入」
//
// 归档分流（用户要求）：
//   · 聊天 App 的长期记忆总结只吃普通聊天，跳过带 deliverySessionId 的消息
//   · 剧情模式下的内容归到群像剧本自己的归档里

import { createOrGetSession, pushChatMessage, loadChatMessages, updateChatMessage } from "./chat-storage";

/** 一段剧情对话（投递起点 → 返回剧情终点）。 */
export type DeliverySession = {
    id: string;
    scriptId: string;
    scriptTitle: string;
    /** 投递出去的起始台词（用于展示与核对）。 */
    originTurnId: string;
    originContent: string;
    characterId: string;
    characterName: string;
    /** 投递时刻。 */
    startedAt: number;
    /** 返回剧情时刻；为空表示这段还没归入。 */
    endedAt?: number;
};

const SESSION_KEY = "float_delivery_sessions_v1";

export function loadDeliverySessions(): DeliverySession[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveDeliverySessions(list: DeliverySession[]) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(list.slice(-200)));
    } catch {
        // 配额满了就放弃，不阻断主流程
    }
}

/** 该角色当前是否有正在进行的剧情对话段。 */
export function getOpenSessionForCharacter(characterId: string): DeliverySession | null {
    const list = loadDeliverySessions();
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const s = list[i];
        if (!s.endedAt && s.characterId === characterId) return s;
    }
    return null;
}

/** 按 sessionId 取。 */
export function getDeliverySession(sessionId: string): DeliverySession | null {
    return loadDeliverySessions().find(s => s.id === sessionId) ?? null;
}

/** 所有还没归入剧情的段（用于群像顶部提示）。 */
export function getPendingSessions(scriptId?: string): DeliverySession[] {
    return loadDeliverySessions().filter(s => !s.endedAt && (!scriptId || s.scriptId === scriptId));
}

export type DeliveryResult =
    | { ok: true; sessionId: string; messageId: string }
    | { ok: false; error: string };

/**
 * 投递：把群像里的一幕投到聊天 App，并开启一段剧情对话段。
 * 如果该角色已有未归入的段，直接复用（避免一次投递开两段）。
 */
export function deliverToChat(params: {
    characterId: string;
    characterName: string;
    content: string;
    scriptId: string;
    scriptTitle: string;
    turnId: string;
    /** 非角色台词（旁白 / 多人混合段）时可显式指定投递给谁。 */
    forceNew?: boolean;
}): DeliveryResult {
    const content = (params.content ?? "").trim();
    if (!content) return { ok: false, error: "内容为空" };
    if (!params.characterId) return { ok: false, error: "缺少角色信息" };

    try {
        const session = createOrGetSession(params.characterId);
        const message = pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content,
            senderName: params.characterName,
        });

        // 已有未归入的段就复用，否则开一段新的
        const existing = params.forceNew ? null : getOpenSessionForCharacter(params.characterId);
        let deliverySessionId: string;
        if (existing && existing.scriptId === params.scriptId) {
            deliverySessionId = existing.id;
            // 复用段时更新终点台词，便于展示"这一段从这里开始"
            const list = loadDeliverySessions().map(s =>
                s.id === existing.id ? { ...s, originContent: content, originTurnId: params.turnId } : s,
            );
            saveDeliverySessions(list);
        } else {
            deliverySessionId = `dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const record: DeliverySession = {
                id: deliverySessionId,
                scriptId: params.scriptId,
                scriptTitle: params.scriptTitle,
                originTurnId: params.turnId,
                originContent: content,
                characterId: params.characterId,
                characterName: params.characterName,
                startedAt: Date.now(),
            };
            saveDeliverySessions([...loadDeliverySessions(), record]);
        }

        // 把这条投递消息标记归属，方便归档时跳过
        markMessagesAsDelivery(session.id, message.id, deliverySessionId);

        return { ok: true, sessionId: deliverySessionId, messageId: message.id };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "投递失败" };
    }
}

/** 从某条消息开始，到当前为止，把这段聊天标记为剧情对话。 */
function markMessagesAsDelivery(chatSessionId: string, fromMessageId: string, deliverySessionId: string) {
    try {
        const messages = loadChatMessages(chatSessionId);
        const idx = messages.findIndex(m => m.id === fromMessageId);
        if (idx < 0) return;
        for (let i = idx; i < messages.length; i += 1) {
            const m = messages[i];
            if (m.deliverySessionId) continue;
            updateChatMessage(m.id, { deliverySessionId });
        }
    } catch {
        // 标记失败不阻断投递
    }
}

/**
 * 返回剧情：关闭这段对话段，收集期间的全部聊天内容。
 *
 * @returns null 表示这段已经关闭过
 */
export function closeDeliverySession(params: {
    deliverySessionId: string;
    characterId: string;
}): { session: DeliverySession; transcript: { role: string; senderName?: string; content: string; at: number }[] } | null {
    const list = loadDeliverySessions();
    const target = list.find(s => s.id === params.deliverySessionId);
    if (!target || target.endedAt) return null;

    let transcript: { role: string; senderName?: string; content: string; at: number }[] = [];
    try {
        const chatSession = createOrGetSession(params.characterId);
        const messages = loadChatMessages(chatSession.id);
        transcript = messages
            .filter(m => m.deliverySessionId === params.deliverySessionId && m.content?.trim())
            .map(m => ({
                role: m.role,
                senderName: m.senderName,
                content: m.content.trim(),
                at: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
            }));
    } catch {
        transcript = [];
    }

    const ended: DeliverySession = { ...target, endedAt: Date.now() };
    saveDeliverySessions(list.map(s => (s.id === target.id ? ended : s)));
    return { session: ended, transcript };
}

/** 把一段对话整理成剧本里的「来自聊天」文本。 */
export function formatTranscriptAsNarration(
    session: DeliverySession,
    transcript: { role: string; senderName?: string; content: string }[],
): string {
    const lines = transcript.map(m => {
        const who = m.role === "user" ? "你" : (m.senderName || session.characterName);
        return `${who}：${m.content}`;
    });
    return `（你们在手机上聊了起来）\n${lines.join("\n")}`;
}

/** 未归入的段落摘要，用于群像顶部常驻提示。 */
export function describePendingSessions(scriptId?: string): string {
    const pending = getPendingSessions(scriptId);
    if (pending.length === 0) return "";
    const names = [...new Set(pending.map(s => s.characterName))].join("、");
    return `有 ${pending.length} 段聊天未归入剧情（${names}）`;
}
