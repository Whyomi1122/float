"use client";

/**
 * 布局诊断：用于定位「点输入框后顶栏被抬高 / 输入框没被顶上来」的问题。
 *
 * 用法：进入聊天室或剧情室，先点「记录 A（键盘关闭）」，再点输入框等键盘完全
 * 弹出后点「记录 B（键盘打开）」，把下面的文本复制发出来。
 * 记录的是几个关键层的高度、位移和定位，能从数字上直接看出是哪一层在动。
 */

import { useState } from "react";

type Snapshot = {
    label: string;
    htmlH: number;
    bodyH: number;
    appRootH: number;
    wrapTop: number;
    wrapH: number;
    wrapTransform: string;
    shellTop: number;
    shellH: number;
    headerTop: number;
    inputTop: number;
    inputBottom: number;
    vvH: number;
    vvTop: number;
    innerH: number;
    active: string;
};

function px(n: number) {
    return Math.round(n);
}

function take(label: string): Snapshot {
    const q = (sel: string) => document.querySelector<HTMLElement>(sel);
    const html = document.documentElement;
    const body = document.body;
    const appRoot = q(".app-root");
    const wrap = q(".phone-shell-wrap");
    const shell = q(".phone-shell");
    // 顶栏：聊天室/剧情室/普通页面各用不同类名，取第一个命中的
    const header =
        q(".chat-room-header") ||
        q(".story-header") ||
        q(".page-header") ||
        q("[class*='-header']");
    // 输入框：取当前有焦点的元素
    const activeEl =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inputBar = q(".chat-input-bar") || q(".story-composer");
    const target = inputBar || activeEl;

    const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const rr = r(appRoot);
    const rw = r(wrap);
    const rs = r(shell);
    const rh = r(header);
    const rt = r(target);

    return {
        label,
        htmlH: px(html.clientHeight),
        bodyH: px(body.clientHeight),
        appRootH: rr ? px(rr.height) : -1,
        wrapTop: rw ? px(rw.top) : -1,
        wrapH: rw ? px(rw.height) : -1,
        wrapTransform: wrap ? getComputedStyle(wrap).transform : "n/a",
        shellTop: rs ? px(rs.top) : -1,
        shellH: rs ? px(rs.height) : -1,
        headerTop: rh ? px(rh.top) : -1,
        inputTop: rt ? px(rt.top) : -1,
        inputBottom: rt ? px(rt.bottom) : -1,
        vvH: px(window.visualViewport?.height ?? 0),
        vvTop: px(window.visualViewport?.offsetTop ?? 0),
        innerH: px(window.innerHeight),
        active: activeEl ? `${activeEl.tagName.toLowerCase()}:${activeEl.className}`.slice(0, 60) : "none",
    };
}

export function LayoutDiagnostics() {
    const [logs, setLogs] = useState<Snapshot[]>([]);

    const record = (label: string) => {
        setLogs((prev) => [...prev.slice(-5), take(label)]);
    };

    const text = logs
        .map((s) => {
            return [
                `【${s.label}】`,
                `html=${s.htmlH} body=${s.bodyH} appRoot=${s.appRootH} innerH=${s.innerH} vvH=${s.vvH} vvTop=${s.vvTop}`,
                `wrap: top=${s.wrapTop} h=${s.wrapH} transform=${s.wrapTransform}`,
                `shell: top=${s.shellTop} h=${s.shellH}`,
                `headerTop=${s.headerTop}`,
                `input: top=${s.inputTop} bottom=${s.inputBottom}`,
                `focus: ${s.active}`,
            ].join("\n");
        })
        .join("\n\n");

    return (
        <div className="flex flex-col gap-3">
            <p className="card-section-label m-0 mx-2">布局诊断</p>

            <div className="g-card flex flex-col gap-3">
                <span className="menu-desc ts-13 leading-relaxed !mt-0">
                    在聊天室或剧情室操作：先点「记录 A」，再点输入框等键盘完全弹出后点「记录 B」，把下方文本复制发出来。
                </span>

                <div className="flex flex-wrap gap-2">
                    <button className="g-pill" onClick={() => record("A 键盘关闭")}>记录 A</button>
                    <button className="g-pill" onClick={() => record("B 键盘打开")}>记录 B</button>
                    <button className="g-pill" onClick={() => record("C 手动")}>记录 C</button>
                    <button className="g-pill" onClick={() => setLogs([])}>清空</button>
                </div>

                <textarea
                    readOnly
                    value={text || "（还没有记录）"}
                    className="w-full rounded-xl p-3 ts-12"
                    style={{
                        minHeight: 260,
                        background: "var(--c-input)",
                        color: "var(--c-text)",
                        fontFamily: "ui-monospace, monospace",
                        whiteSpace: "pre",
                    }}
                />
            </div>
        </div>
    );
}
