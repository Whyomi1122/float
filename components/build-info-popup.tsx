"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { BUILD_INFO, SEEN_BUILD_KEY } from "@/lib/build-info";

/**
 * 进入 float 时弹出「本次更新了什么」。
 * 仅在版本号与本地记录的已看版本不同时弹出（看过后不再打扰）。
 */
export function BuildInfoPopup() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        let seen = "";
        try { seen = localStorage.getItem(SEEN_BUILD_KEY) || ""; } catch { /* ignore */ }
        if (seen !== BUILD_INFO.version) setOpen(true);
    }, []);

    const close = () => {
        try { localStorage.setItem(SEEN_BUILD_KEY, BUILD_INFO.version); } catch { /* ignore */ }
        setOpen(false);
    };

    if (!open) return null;

    return (
        <div className="modal-overlay" data-ui="modal" role="presentation" onClick={close} style={{ zIndex: 400 }}>
            <div
                className="modal-dialog"
                data-ui="modal-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="版本更新"
                onClick={e => e.stopPropagation()}
                style={{ animation: "modalSoftRise 0.28s cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
                <div className="modal-header" data-ui="modal-header">
                    <div className="ui-icon-circle" data-variant="action">
                        <Sparkles size={20} />
                    </div>
                    <h3 className="modal-title">已更新 · {BUILD_INFO.version}</h3>
                </div>
                <div className="modal-body" data-ui="modal-body" style={{ maxHeight: "56vh", overflowY: "auto" }}>
                    {BUILD_INFO.entries.slice(0, 1).map(entry => (
                        <div key={entry.version} style={{ marginBottom: 14 }}>
                            <p style={{ fontWeight: 600, marginBottom: 4 }}>
                                {entry.title}
                                <span style={{ fontWeight: 400, opacity: 0.5, marginLeft: 6, fontSize: 12 }}>v{entry.version}</span>
                            </p>
                            <ul style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                                {entry.items.map((it, i) => (
                                    <li key={i} style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.85 }}>{it}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                    <p style={{ marginTop: 6, fontSize: 11, opacity: 0.45 }}>
                        构建 {BUILD_INFO.commit} · 与 Vercel 部署 commit 核对
                    </p>
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button type="button" className="ui-btn ui-btn-primary" onClick={close}>
                        知道了
                    </button>
                </div>
            </div>
        </div>
    );
}
