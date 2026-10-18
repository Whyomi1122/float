// lib/ensemble-delivery.ts
// 群像 → 聊天 App 的「手动投递」（2026-10-18 用户拍板）
//
// 为什么是手动而不是自动双向同步：
//   用户主要在群像里推线下剧情，实时同步会在他最投入的时候弹通知打断节奏。
//   所以这里只提供两个显式动作，节奏完全由用户掌控：
//     · 投递到聊天：把一条剧情回合变成聊天 App 里的一条真实消息
//     · 带回剧情：把聊天里的回复变成群像里的一条旁白/台词
//
// 注意：这里是"单向搬运"，不是状态同步 —— 搬运后两边各自独立演进，
//       不做回写、不做去重表，避免复杂度和冲突。

import { createOrGetSession, pushChatMessage, loadChatMessages } from "./chat-storage";

/** 投递结果。 */
export type DeliveryResult =
    | { ok: true; sessionId: string; messageId: string }
    | { ok: false; error: string };

/**
 * 把群像里的一条角色台词投递到聊天 App（作为该角色发给用户的消息）。
 *
 * @param characterId 说话的角色 id（= EnsembleCastMember.id）
 * @param characterName 角色名（会话预览兜底用）
 * @param content 要投递的文本
 */
export function deliverToChat(params: {
    characterId: string;
    characterName: string;
    content: string;
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
        return { ok: true, sessionId: session.id, messageId: message.id };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "投递失败" };
    }
}

/**
 * 取该角色与用户最近的一条对话，用于「带回剧情」。
 * 只取最后一条，不做批量——用户要的是把某句具体的话带回去。
 */
export function pickLatestChatReply(characterId: string): { content: string; role: string } | null {
    try {
        const session = createOrGetSession(characterId);
        const messages = loadChatMessages(session.id);
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const msg = messages[i];
            if (!msg.content?.trim()) continue;
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            return { content: msg.content.trim(), role: msg.role };
        }
        return null;
    } catch {
        return null;
    }
}
