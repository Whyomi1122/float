"use client";

/**
 * 键盘布局探针：全程自动记录，不需要用户在页面间来回切换。
 *
 * 原理：监听输入框的 focusin / focusout 和 visualViewport 变化，
 * 自动抓关键层的高度/位移，并把最新一条以极小的字显示在右下角。
 * 用户点完输入框弹完键盘后，直接截图右下角那几行即可。
 */

import { useEffect, useState } from "react";

type Snap = {
    label: string;
    html: number;
    app: number;
    wrapH: number;
    wrapTop: number;
    tf: string;
    shellH: number;
    headerTop: number;
    inputTop: number;
    inputBottom: number;
    vvH: number;
    vvTop: number;
    innerH: number;
};

function grab(label: string): Snap {
    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const pick = (sels: string[]) => {
        for (const s of sels) {
            const el = q(s);
            if (el) return el;
        }
        return null;
    };
    const app = q(".app-root");
    const wrap = q(".phone-shell-wrap");
    const shell = q(".phone-shell");
    const header = pick([".chat-room-header", ".story-header", ".page-header"]);
    const input = pick([".chat-input-bar", ".story-composer"]);
    const r = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
    const ra = r(app), rw = r(wrap), rs = r(shell), rh = r(header), ri = r(input);
    return {
        label,
        html: Math.round(document.documentElement.clientHeight),
        app: ra ? Math.round(ra.height) : -1,
        wrapH: rw ? Math.round(rw.height) : -1,
        wrapTop: rw ? Math.round(rw.top) : -1,
        tf: wrap ? getComputedStyle(wrap).transform.slice(0, 28) : "n/a",
        shellH: rs ? Math.round(rs.height) : -1,
        headerTop: rh ? Math.round(rh.top) : -1,
        inputTop: ri ? Math.round(ri.top) : -1,
        inputBottom: ri ? Math.round(ri.bottom) : -1,
        vvH: Math.round(window.visualViewport?.height ?? 0),
        vvTop: Math.round(window.visualViewport?.offsetTop ?? 0),
        innerH: Math.round(window.innerHeight),
    };
}

export function KeyboardProbe() {
    const [last, setLast] = useState<Snap | null>(null);
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        let first = true;
        const snap = (label: string) => setLast(grab(label));

        // 进页面先记一次基线
        const t0 = window.setTimeout(() => snap("进入页面"), 600);

        const onFocusIn = () => {
            snap("聚焦输入框");
            // 键盘动画结束后再抓一次（浏览器在此期间不给中间值）
            window.setTimeout(() => snap("聚焦后 600ms"), 600);
            window.setTimeout(() => snap("聚焦后 1200ms"), 1200);
        };
        const onFocusOut = () => window.setTimeout(() => snap("失焦后 300ms"), 300);
        const onVv = () => snap("视口变化");

        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("focusout", onFocusOut, true);
        window.visualViewport?.addEventListener("resize", onVv);

        return () => {
            window.clearTimeout(t0);
            document.removeEventListener("focusin", onFocusIn, true);
            document.removeEventListener("focusout", onFocusOut, true);
            window.visualViewport?.removeEventListener("resize", onVv);
            void first;
        };
    }, []);

    if (!last) return null;
    if (hidden) {
        return (
            <button
                onClick={() => setHidden(false)}
                style={{
                    position: "fixed", right: 6, bottom: 6, zIndex: 99999,
                    fontSize: 10, padding: "2px 6px", borderRadius: 6,
                    background: "rgba(0,0,0,.5)", color: "#fff", border: "none",
                }}
            >探针</button>
        );
    }

    const line = (k: string, v: string | number) => `${k}=${v}`;
    return (
        <div
            onClick={() => setHidden(true)}
            style={{
                position: "fixed", left: 4, bottom: 4, zIndex: 99999,
                background: "rgba(0,0,0,.72)", color: "#7CFFB2",
                fontFamily: "ui-monospace, monospace", fontSize: 9.5,
                lineHeight: 1.35, padding: "4px 6px", borderRadius: 6,
                pointerEvents: "auto", maxWidth: "78vw",
                whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}
        >
            {`[${last.label}]\n` +
                line("html", last.html) + " " + line("app", last.app) + " " + line("shellH", last.shellH) + "\n" +
                line("wrapTop", last.wrapTop) + " " + line("wrapH", last.wrapH) + " tf=" + last.tf + "\n" +
                line("headerTop", last.headerTop) + "\n" +
                line("inTop", last.inputTop) + " " + line("inBot", last.inputBottom) + "\n" +
                line("vvH", last.vvH) + " vvTop=" + last.vvTop + " innerH=" + last.innerH}
        </div>
    );
}
