"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Sparkles, Trash2, Check } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive } from "@/lib/memory-service";
import { simpleLLMCall } from "@/lib/api-helpers";
import { resolveAuxiliaryApiConfig } from "@/lib/settings-storage";
import type { MemoryEntry } from "@/lib/memory-types";

/** 归档页：把聊天记录提炼成一份可编辑的长文档，确认后写入角色记忆（世界书级）。 */
export function ChatArchivePanel({
    characterId,
    characterName,
    sessionId,
    onClose,
}: {
    characterId: string;
    characterName: string;
    sessionId?: string;
    onClose: () => void;
}) {
    const [archives, setArchives] = useState<MemoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [summarizing, setSummarizing] = useState(false);
    const [draft, setDraft] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState("");
    const noticeTimer = useRef<number | null>(null);
    const onNotice = useCallback((msg: string) => {
        setNotice(msg);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
    }, []);
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const list = await loadMemoryEntriesByType(characterId, "archive");
            setArchives([...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
        } catch {
            setArchives([]);
        } finally {
            setLoading(false);
        }
    }, [characterId]);

    useEffect(() => { void load(); }, [load]);

    /** 收集聊天记录文本（若有 sessionId）。 */
    const collectTranscript = useCallback((): string => {
        if (!sessionId) return "";
        const msgs: ChatMessage[] = loadChatMessages(sessionId);
        const lines: string[] = [];
        for (const m of msgs) {
            if (m.isRetracted) continue;
            const role = m.role === "user" ? "我" : m.role === "assistant" ? characterName : null;
            if (!role) continue;
            const text = (m.content || "").trim();
            if (!text) continue;
            lines.push(`${role}：${text}`);
        }
        return lines.join("\n");
    }, [sessionId, characterName]);

    /** 一键提炼：AI 总结一次，产出可编辑草稿。 */
    const handleSummarize = useCallback(async () => {
        const transcript = collectTranscript();
        if (!transcript.trim()) {
            onNotice?.("暂无可提炼的聊天记录");
            return;
        }
        setSummarizing(true);
        try {
            const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
            if (!apiConfig || !apiConfig.apiKey) {
                onNotice?.("未配置记忆总结模型（设置 → 辅助模型）");
                return;
            }
            const res = await simpleLLMCall(
                apiConfig,
                [
                    {
                        role: "system",
                        content:
                            "你是记忆归档助手。请把下面的聊天记录提炼成一份「发生了什么」的长期档案。" +
                            "要求：①只记录已发生的事实、双方关系变化、重要约定、情绪节点、物品/地点状态；" +
                            "②用第三人称叙述，条理清晰，可分点；③不要编造，不要写没发生的事；" +
                            "④不要加评价和推测。只输出档案正文。",
                    },
                    { role: "user", content: transcript },
                ],
                { temperature: 0.3, label: "chat-archive" },
            );
            if (!res.content) {
                onNotice?.(res.error || "提炼失败");
                return;
            }
            setDraft(res.content.trim());
            // 自动聚焦到草稿框
            setTimeout(() => taRef.current?.focus(), 80);
        } finally {
            setSummarizing(false);
        }
    }, [collectTranscript, characterName, onNotice]);

    /** 确认写入归档。 */
    const handleConfirmArchive = useCallback(async () => {
        const text = draft.trim();
        if (!text) {
            onNotice?.("内容为空");
            return;
        }
        setSaving(true);
        try {
            const res = await commitArchive(characterId, text, "chat");
            if (res.success) {
                onNotice?.("已归档，写入角色记忆");
                setDraft("");
                await load();
            } else {
                onNotice?.(res.error || "归档失败");
            }
        } finally {
            setSaving(false);
        }
    }, [draft, characterId, onNotice, load]);

    const handleSaveEdit = useCallback(async (entry: MemoryEntry) => {
        const text = editText.trim();
        if (!text) { onNotice?.("内容为空"); return; }
        setSaving(true);
        try {
            // 归档编辑：删旧写新（墓碑会自动记录旧内容指纹，避免复活）
            await deleteArchive(characterId, entry.id);
            const res = await commitArchive(characterId, text, entry.sourceApp);
            if (res.success) { onNotice?.("已保存"); setEditingId(null); await load(); }
            else onNotice?.(res.error || "保存失败");
        } finally {
            setSaving(false);
        }
    }, [editText, characterId, onNotice, load]);

    const handleDelete = useCallback(async (entry: MemoryEntry) => {
        await deleteArchive(characterId, entry.id);
        setArchives(prev => prev.filter(e => e.id !== entry.id));
        onNotice?.("已删除（并加入防污染墓碑）");
    }, [characterId, onNotice]);

    const hasTranscript = useMemo(() => (sessionId ? loadChatMessages(sessionId).length > 0 : false), [sessionId]);

    return (
        <div className="absolute inset-0 z-50 flex flex-col" style={{ background: "var(--bg-primary, #f5f5f7)" }} data-ens-ui="1">
            {/* 顶栏 */}
            <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
                <h2 className="ts-17 font-medium">归档</h2>
                <button className="rounded-full px-3 py-1 ts-13" style={{ background: "var(--surface-1, #fff)" }} onClick={onClose}>
                    <ArrowLeft size={14} className="inline mr-1" />返回
                </button>
            </div>
            <p className="px-4 ts-11 text-secondary mb-3 shrink-0">
                {characterName} · 归档为人工确认的长档案，权重等同世界书，会始终注入角色记忆
            </p>

            <div className="flex-1 overflow-y-auto px-4 pb-8">
                {/* 提炼区 */}
                <div className="rounded-2xl p-3 mb-4" style={{ background: "var(--surface-1, #fff)" }}>
                    <div className="flex items-center justify-between mb-2">
                        <span className="ts-13 font-medium">从聊天记录提炼</span>
                        <button
                            className="rounded-xl px-3 py-1.5 ts-12 flex items-center gap-1"
                            style={{ background: "var(--accent, #6c5ce7)", color: "#fff", opacity: hasTranscript && !summarizing ? 1 : 0.5 }}
                            disabled={!hasTranscript || summarizing}
                            onClick={handleSummarize}
                        >
                            {summarizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            {summarizing ? "提炼中…" : "提炼"}
                        </button>
                    </div>
                    {!hasTranscript && <p className="ts-11 text-secondary">当前会话暂无记录可提炼。</p>}
                    {draft && (
                        <>
                            <textarea
                                ref={taRef}
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                rows={10}
                                className="w-full rounded-xl p-2 ts-13 mt-1"
                                style={{ background: "var(--surface-2, rgba(0,0,0,0.03))", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                            />
                            <div className="flex gap-2 mt-2">
                                <button
                                    className="flex-1 rounded-xl py-2 ts-13 flex items-center justify-center gap-1"
                                    style={{ background: "var(--accent, #6c5ce7)", color: "#fff", opacity: saving ? 0.6 : 1 }}
                                    disabled={saving}
                                    onClick={handleConfirmArchive}
                                >
                                    <Check size={14} /> {saving ? "写入中…" : "确认归档"}
                                </button>
                                <button
                                    className="rounded-xl py-2 px-3 ts-13"
                                    style={{ background: "var(--surface-1, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))" }}
                                    onClick={() => setDraft("")}
                                >
                                    放弃
                                </button>
                            </div>
                        </>
                    )}
                </div>

                {/* 已归档列表 */}
                <div className="ts-13 font-medium mb-2">已归档（{archives.length}）</div>
                {loading ? (
                    <p className="ts-12 text-secondary text-center py-6">加载中…</p>
                ) : archives.length === 0 ? (
                    <p className="ts-12 text-secondary text-center py-6">暂无归档。点上方「提炼」生成草稿，编辑后确认即可归档。</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {archives.map(entry => {
                            const isEditing = editingId === entry.id;
                            return (
                                <div key={entry.id} className="rounded-2xl p-3" style={{ background: "var(--surface-1, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))" }}>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="ts-11 text-secondary">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
                                        <div className="flex gap-2">
                                            {isEditing ? (
                                                <>
                                                    <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} disabled={saving} onClick={() => handleSaveEdit(entry)}>保存</button>
                                                    <button className="ts-12 text-secondary" onClick={() => setEditingId(null)}>取消</button>
                                                </>
                                            ) : (
                                                <>
                                                    <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} onClick={() => { setEditingId(entry.id); setEditText(entry.content); }}>编辑</button>
                                                    <button className="ts-12" style={{ color: "var(--danger, #e74c3c)" }} onClick={() => handleDelete(entry)}><Trash2 size={12} /></button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    {isEditing ? (
                                        <textarea
                                            value={editText}
                                            onChange={e => setEditText(e.target.value)}
                                            rows={8}
                                            className="w-full rounded-xl p-2 ts-13"
                                            style={{ background: "var(--surface-2, rgba(0,0,0,0.03))", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                                        />
                                    ) : (
                                        <p className="ts-13 whitespace-pre-wrap" style={{ lineHeight: 1.7 }}>{entry.content}</p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            {notice && (
                <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[60] rounded-full px-4 py-2 ts-13"
                    style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}>{notice}</div>
            )}
        </div>
    );
}
