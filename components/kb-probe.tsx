"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 键盘诊断浮层（真机用，挂在 .phone-shell 内部）
 * ------------------------------------------------------------------
 * 用途：不再靠猜。持续显示实时数据，点开输入框时数字会自己跳，
 *       你只需在我说的时机点「复制」，把数据发回。
 *
 * 为什么必须挂在 .phone-shell 内部：
 *   .phone-shell 有 transform，会形成新的包含块；只有挂在里面，
 *   getBoundingClientRect 拿到的才是壳子的真实视觉位置。
 *
 * 开关：URL 带 ?kb=1 显示（如 https://域名/?kb=1）。
 *       这样不需要在设置里加入口，也不影响正常使用。
 */

type Snap = {
    vvH: number;
    vvTop: number;
    vvScale: number;
    innerH: number;
    outerH: number;
    shellH: number;
    shellTop: number;
    shellBottom: number;
    kbInset: number;
    ae: string;
    aTop: number | null;
    aBottom: number | null;
    docScroll: number;
};

function describeEl(el: Element | null): string {
    if (!el || el === document.body) return "-";
    const tag = el.tagName.toLowerCase();
    const cls = (el.className || "").toString().trim().split(/\s+/).slice(0, 2).join(".");
    const ph = (el as HTMLInputElement).placeholder;
    return `${tag}${cls ? "." + cls : ""}${ph ? `「${ph}」` : ""}`;
}

export function KbProbe() {
    const [on, setOn] = useState(false);
    const [open, setOpen] = useState(false);
    const [snap, setSnap] = useState<Snap | null>(null);
    const [log, setLog] = useState<string[]>([]);
    const [copied, setCopied] = useState(false);
    const activeRef = useRef<Element | null>(null);
    const lastKeyRef = useRef<string>("");

    // URL ?kb=1 才启用，避免误触
    useEffect(() => {
        try {
            const p = new URLSearchParams(window.location.search);
            if (p.get("kb") === "1") setOn(true);
        } catch {}
    }, []);

    useEffect(() => {
        if (!on) return;
        const onFocusIn = (e: FocusEvent) => {
            activeRef.current = (e.target as Element) ?? null;
        };
        document.addEventListener("focusin", onFocusIn, true);
        return () => document.removeEventListener("focusin", onFocusIn, true);
    }, [on]);

    const sample = useCallback(() => {
        const vv = window.visualViewport;
        const shell = document.querySelector(".phone-shell") as HTMLElement | null;
        const sr = shell?.getBoundingClientRect();
        const active = document.activeElement;
        const isField =
            active &&
            (active.tagName === "INPUT" ||
                active.tagName === "TEXTAREA" ||
                (active as HTMLElement).isContentEditable);
        const anchorEl: Element | null = (isField ? active : activeRef.current) ?? null;
        const ar = anchorEl?.getBoundingClientRect();

        const s: Snap = {
            vvH: vv ? Math.round(vv.height) : -1,
            vvTop: vv ? Math.round(vv.offsetTop) : -1,
            vvScale: vv ? Math.round(vv.scale * 100) / 100 : -1,
            innerH: window.innerHeight,
            outerH: window.outerHeight,
            shellH: sr ? Math.round(sr.height) : -1,
            shellTop: sr ? Math.round(sr.top) : -1,
            shellBottom: sr ? Math.round(sr.bottom) : -1,
            kbInset: vv ? Math.round(window.innerHeight - vv.height) : -1,
            ae: describeEl(anchorEl),
            aTop: ar ? Math.round(ar.top) : null,
            aBottom: ar ? Math.round(ar.bottom) : null,
            docScroll: Math.round(window.scrollY),
        };
        setSnap(s);

        // 只在关键值变化时追加一行，避免刷屏
        const key = `${s.vvH}|${s.vvTop}|${s.innerH}|${s.shellH}|${s.shellTop}|${s.aTop}|${s.aBottom}|${s.ae}`;
        if (key !== lastKeyRef.current) {
            lastKeyRef.current = key;
            const t = Math.round(performance.now());
            setLog((prev) => {
                const next = [
                    ...prev,
                    `t=${t} vvH=${s.vvH} vvTop=${s.vvTop} inner=${s.innerH} kb=${s.kbInset} shellH=${s.shellH} shellTop=${s.shellTop} a=[${s.aTop ?? "-"},${s.aBottom ?? "-"}] ${s.ae}`,
                ];
                return next.length > 120 ? next.slice(next.length - 120) : next;
            });
        }
    }, []);

    useEffect(() => {
        if (!on) return;
        let raf = 0;
        const loop = () => {
            sample();
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [on, sample]);

    if (!on) return null;

    const copy = async () => {
        const header = "KB-PROBE v1  (VIVO S15 / Firefox Android)";
        const text = [header, ...log].join("\n");
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
    };

    // 折叠态：右下角小圆点，实时显示键盘高度
    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                style={{
                    position: "absolute",
                    right: 10,
                    bottom: 96,
                    zIndex: 99999,
                    width: 46,
                    height: 46,
                    borderRadius: 23,
                    background: "rgba(17,17,17,0.88)",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1.15,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
                }}
                aria-label="打开键盘诊断"
            >
                <span style={{ fontSize: 13 }}>⌨</span>
                <span>{snap ? snap.kbInset : "-"}</span>
            </button>
        );
    }

    const row = (k: string, v: React.ReactNode) => (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ color: "#8a8a8a" }}>{k}</span>
            <span style={{ fontWeight: 700 }}>{v}</span>
        </div>
    );

    return (
        <div
            style={{
                position: "absolute",
                inset: "auto 8px 8px 8px",
                zIndex: 99999,
                maxHeight: "78%",
                display: "flex",
                flexDirection: "column",
                background: "rgba(255,255,255,0.98)",
                borderRadius: 14,
                boxShadow: "0 8px 30px rgba(0,0,0,0.28)",
                border: "1px solid rgba(0,0,0,0.08)",
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                overflow: "hidden",
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderBottom: "1px solid rgba(0,0,0,0.06)",
                }}
            >
                <strong style={{ flex: 1, fontSize: 12 }}>键盘诊断（实时）</strong>
                <button
                    type="button"
                    onClick={copy}
                    style={{ padding: "5px 10px", borderRadius: 7, background: "#111", color: "#fff", fontWeight: 700 }}
                >
                    {copied ? "已复制" : "复制数据"}
                </button>
                <button
                    type="button"
                    onClick={() => setLog([])}
                    style={{ padding: "5px 10px", borderRadius: 7, background: "#eee" }}
                >
                    清空
                </button>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    style={{ padding: "5px 10px", borderRadius: 7, background: "#eee" }}
                >
                    收起
                </button>
            </div>

            {snap && (
                <div style={{ padding: "8px 10px", borderBottom: "1px solid rgba(0,0,0,0.06)", lineHeight: 1.7 }}>
                    {row("可视区高 vvH", snap.vvH)}
                    {row("可视区顶 vvTop", snap.vvTop)}
                    {row("布局高 innerH", snap.innerH)}
                    {row("键盘高 kb", snap.kbInset)}
                    {row("壳高 shellH", snap.shellH)}
                    {row("壳顶 shellTop", snap.shellTop)}
                    {row("输入框 top/bottom", `${snap.aTop ?? "-"} / ${snap.aBottom ?? "-"}`)}
                    {row("聚焦元素", <span style={{ fontWeight: 400, fontSize: 10 }}>{snap.ae}</span>)}
                </div>
            )}

            <div style={{ overflow: "auto", padding: "6px 10px", whiteSpace: "pre-wrap", fontSize: 10, lineHeight: 1.5 }}>
                {log.length ? log.join("\n") : "（等待变化…去点一个输入框）"}
            </div>
        </div>
    );
}
