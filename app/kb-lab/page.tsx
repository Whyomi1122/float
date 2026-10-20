"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 键盘诊断页（真机用）
 * ------------------------------------------------------------------
 * 目的：不再靠猜，直接把「键盘弹起过程中每帧发生了什么」量出来。
 *
 * 记录内容（每个采样点）：
 *   t        相对开始记录的毫秒数
 *   vvH      visualViewport.height（可视区高度）
 *   vvTop    visualViewport.offsetTop（可视区在布局坐标里的顶部偏移，键盘弹出时通常 > 0）
 *   vvScale  visualViewport.scale
 *   innerH   window.innerHeight（布局视口高度）
 *   outerH   window.outerHeight
 *   shellH   .phone-screen 的实际高度（float 手机壳），不在 float 里则为 -
 *   shellTop .phone-screen 的 rect.top
 *   kbInset  推断的键盘高度 = innerH - vvH
 *   ae       当前聚焦元素（tag + 标识）
 *   anchor   焦点元素 / 或测试框的 rect.top 与 rect.bottom
 *
 * 用法：
 *   1. 打开 /kb-lab
 *   2. 点「开始记录」
 *   3. 去输入框点一下，等键盘完全弹出，再收起
 *   4. 回本页点「停止」，把「精简版」文本框里的内容发给开发者
 *
 * 注意：本页不修改任何业务布局，纯采样。
 */

type Sample = {
    t: number;
    vvH: number;
    vvTop: number;
    vvScale: number;
    innerH: number;
    outerH: number;
    shellH: number | null;
    shellTop: number | null;
    kbInset: number;
    ae: string;
    anchorTop: number | null;
    anchorBottom: number | null;
    docScroll: number;
};

const MAX_MS = 20000;

function describeEl(el: Element | null): string {
    if (!el) return "-";
    const tag = el.tagName.toLowerCase();
    const cls = (el.className || "").toString().trim().split(/\s+/).slice(0, 2).join(".");
    const ph = (el as HTMLInputElement).placeholder;
    return `${tag}${cls ? "." + cls : ""}${ph ? `(${ph})` : ""}`;
}

export default function KeyboardLabPage() {
    const [recording, setRecording] = useState(false);
    const [samples, setSamples] = useState<Sample[]>([]);
    const [error, setError] = useState("");

    const rafRef = useRef<number>(0);
    const startRef = useRef<number>(0);
    const bufRef = useRef<Sample[]>([]);
    const anchorRef = useRef<Element | null>(null);
    const activeRef = useRef<Element | null>(null);

    useEffect(() => {
        // 记录「最近获得焦点」的元素，键盘收起后 document.activeElement 可能已经变回 body
        const onFocusIn = (e: FocusEvent) => {
            activeRef.current = (e.target as Element) ?? null;
        };
        document.addEventListener("focusin", onFocusIn, true);
        return () => document.removeEventListener("focusin", onFocusIn, true);
    }, []);

    const tick = useCallback(() => {
        const vv = window.visualViewport;
        const now = performance.now();
        const t = Math.round(now - startRef.current);
        const shell = document.querySelector(".phone-screen") as HTMLElement | null;
        const shellRect = shell?.getBoundingClientRect();

        const active = document.activeElement;
        const isField =
            active &&
            (active.tagName === "INPUT" ||
                active.tagName === "TEXTAREA" ||
                (active as HTMLElement).isContentEditable);
        // 优先量当前聚焦的输入框，否则量最近聚焦过的
        const anchorEl: Element | null = (isField ? active : activeRef.current) ?? null;
        const anchorRect = anchorEl?.getBoundingClientRect();

        bufRef.current.push({
            t,
            vvH: vv ? Math.round(vv.height) : -1,
            vvTop: vv ? Math.round(vv.offsetTop) : -1,
            vvScale: vv ? Math.round(vv.scale * 100) / 100 : -1,
            innerH: window.innerHeight,
            outerH: window.outerHeight,
            shellH: shellRect ? Math.round(shellRect.height) : null,
            shellTop: shellRect ? Math.round(shellRect.top) : null,
            kbInset: vv ? Math.round(window.innerHeight - vv.height) : -1,
            ae: describeEl(anchorEl),
            anchorTop: anchorRect ? Math.round(anchorRect.top) : null,
            anchorBottom: anchorRect ? Math.round(anchorRect.bottom) : null,
            docScroll: Math.round(window.scrollY),
        });

        if (t < MAX_MS) {
            rafRef.current = requestAnimationFrame(tick);
        } else {
            setRecording(false);
            setSamples([...bufRef.current]);
        }
    }, []);

    const start = () => {
        bufRef.current = [];
        setSamples([]);
        startRef.current = performance.now();
        setRecording(true);
        setError("");
        rafRef.current = requestAnimationFrame(tick);
    };

    const stop = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        setRecording(false);
        setSamples([...bufRef.current]);
    };

    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    // 精简输出：只保留「有变化」的行，方便看时序
    const compact = (() => {
        const lines: string[] = [];
        let prev: Sample | null = null;
        for (const s of samples) {
            const changed =
                !prev ||
                s.vvH !== prev.vvH ||
                s.vvTop !== prev.vvTop ||
                s.innerH !== prev.innerH ||
                s.shellH !== prev.shellH ||
                s.shellTop !== prev.shellTop ||
                s.anchorTop !== prev.anchorTop ||
                s.anchorBottom !== prev.anchorBottom ||
                s.ae !== prev.ae;
            if (changed) {
                lines.push(
                    `t=${String(s.t).padStart(4)}ms vvH=${s.vvH} vvTop=${s.vvTop} innerH=${s.innerH} ` +
                        `kbInset=${s.kbInset} shellH=${s.shellH ?? "-"} shellTop=${s.shellTop ?? "-"} ` +
                        `anchor[${s.anchorTop ?? "-"},${s.anchorBottom ?? "-"}] ae=${s.ae}`,
                );
            }
            prev = s;
        }
        return lines.join("\n");
    })();

    const summary = (() => {
        if (!samples.length) return null;
        const vvHs = samples.map((s) => s.vvH).filter((v) => v >= 0);
        const shells = samples.map((s) => s.shellH).filter((v): v is number => v != null);
        const shellTops = samples.map((s) => s.shellTop).filter((v): v is number => v != null);
        return {
            帧数: samples.length,
            总时长: `${samples[samples.length - 1].t}ms`,
            vvH范围: `${Math.min(...vvHs)} ~ ${Math.max(...vvHs)}`,
            innerH: samples[0].innerH,
            outerH: samples[0].outerH,
            壳高范围: shells.length ? `${Math.min(...shells)} ~ ${Math.max(...shells)}` : "（不在 float 壳内）",
            壳顶范围: shellTops.length ? `${Math.min(...shellTops)} ~ ${Math.max(...shellTops)}` : "-",
            最终键盘高: samples[samples.length - 1].kbInset,
        };
    })();

    return (
        <div style={{ padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.6 }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>键盘诊断</h1>
            <p style={{ color: "#888", marginBottom: 12 }}>
                点开始 → 去输入框聚焦（键盘完全弹出）→ 收起 → 回来点停止。记录 {MAX_MS / 1000} 秒。
            </p>

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <button
                    onClick={start}
                    style={{
                        padding: "12px 20px",
                        borderRadius: 10,
                        background: "#111",
                        color: "#fff",
                        fontWeight: 600,
                    }}
                >
                    {recording ? "重新开始" : "开始记录"}
                </button>
                <button
                    onClick={stop}
                    style={{
                        padding: "12px 20px",
                        borderRadius: 10,
                        background: samples.length || recording ? "#111" : "#eee",
                        color: samples.length || recording ? "#fff" : "#333",
                        fontWeight: 700,
                    }}
                >
                    {recording ? "停止（记录中）" : "停止"}
                </button>
                <button
                    onClick={() => {
                        setSamples([]);
                        setError("");
                    }}
                    style={{ padding: "12px 20px", borderRadius: 10, background: "#eee", fontWeight: 600 }}
                >
                    清空
                </button>
            </div>

            <p style={{ color: "#888", marginBottom: 12, fontSize: 12 }}>
                {recording
                    ? `正在记录：已录 ${samples.length} 帧。去点输入框，等键盘弹完再收起，然后回来按「停止」。`
                    : samples.length
                      ? `已录 ${samples.length} 帧，可以复制下面的数据了。`
                      : "还没开始。"}
            </p>

            {summary && (
                <div style={{ background: "#f6f6f6", padding: 12, borderRadius: 10, marginBottom: 12 }}>
                    {Object.entries(summary).map(([k, v]) => (
                        <div key={k}>
                            <strong>{k}:</strong> {String(v)}
                        </div>
                    ))}
                </div>
            )}

            {samples.length > 0 && (
                <>
                    <div style={{ marginBottom: 6, fontWeight: 700 }}>精简版（只显示变化行）——复制这段给我</div>
                    <button
                        onClick={() => {
                            const ta = document.querySelector("textarea[data-kb-out]") as HTMLTextAreaElement | null;
                            if (!ta) return;
                            ta.select();
                            try {
                                void navigator.clipboard.writeText(compact);
                            } catch {
                                document.execCommand("copy");
                            }
                        }}
                        style={{
                            padding: "8px 16px",
                            borderRadius: 8,
                            background: "#111",
                            color: "#fff",
                            fontWeight: 600,
                            marginBottom: 8,
                        }}
                    >
                        一键复制
                    </button>
                    <textarea
                        readOnly
                        data-kb-out
                        value={compact}
                        onFocus={() => {
                            // 本页自身也聚焦输入框，避免污染采样：仅在非记录态允许
                        }}
                        style={{
                            width: "100%",
                            height: 260,
                            fontFamily: "ui-monospace, monospace",
                            fontSize: 11,
                            padding: 8,
                            borderRadius: 8,
                            border: "1px solid #ddd",
                        }}
                    />
                </>
            )}

            {error && <div style={{ color: "#c00", marginTop: 8 }}>{error}</div>}
        </div>
    );
}
