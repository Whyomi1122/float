"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { BUILD_INFO, SEEN_BUILD_KEY } from "@/lib/build-info";

/**
 * 常驻版本卡片 —— 进入 float 时固定显示本次构建信息。
 *
 * 为什么不按「已看过就不再弹」：
 *   之前版本号靠手写，经常和线上实际部署对不上，导致无法确认「我看的是哪一版」。
 *   现在改为每次进入都显示，并且 commit 来自构建期注入的真实 git hash，
 *   关闭后仅记录一次（用于兼容旧的 localStorage 键，不再拦截显示）。
 */
export function BuildInfoPopup() {
    const [open, setOpen] = useState(true);
    /** 实时读取 --kb-height，用于确认键盘补偿是否生效 */
    const [kbHeight, setKbHeight] = useState("0px");

    useEffect(() => {
        const read = () =>
            setKbHeight(
                (document.documentElement.style.getPropertyValue("--kb-height") || "0px").trim() || "0px",
            );
        read();
        const id = window.setInterval(read, 500);
        return () => window.clearInterval(id);
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        // 记住已看过（保留该键，供其它地方判断），但不再据此隐藏
        try { localStorage.setItem(SEEN_BUILD_KEY, BUILD_INFO.version); } catch { /* ignore */ }
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
                        构建 {BUILD_INFO.commit}
                        {BUILD_INFO.builtAt ? ` · ${BUILD_INFO.builtAt}` : ""}
                        <br />
                        键盘补偿 --kb-height：
                        <span style={{ fontWeight: 600 }}>{kbHeight}</span>
                        {" "}（弹键盘时应为 200~350 左右）
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
