"use client";

/**
 * 键盘状态 hook —— 壳子不再收缩后，靠它让「输入栏」自己避开键盘。
 *
 * 背景：
 *   旧的 --app-vh 方案让整个手机壳跟键盘收缩，副作用太大（底栏上移、
 *   消息列表裁切、输入栏延迟跳）。现在壳子固定满高，键盘是「盖」上来的，
 *   所以需要把「键盘占了多少」单独算出来，供给贴在底部的输入栏使用。
 *
 * 写入的 CSS 变量（挂在 <html> 上）：
 *   --kb-height   键盘高度（px），未弹出时为 0
 *   同时给 <body> 打 .kb-open 类，方便样式侧直接判断。
 *
 * 说明：
 *   安卓浏览器只在键盘动画结束时才更新 visualViewport.height，
 *   所以这个值天然会「晚一步」到达 —— 这是浏览器限制，无法消除。
 *   好处是它不会再引起任何布局塌陷，只是输入栏在那一刻归位。
 */

import { useEffect } from "react";

/** 键盘高度阈值：超过它才认为键盘真的弹起了（过滤地址栏收起等小抖动） */
const KB_THRESHOLD = 120;

export function useKeyboardInset(): void {
    useEffect(() => {
        if (typeof window === "undefined") return;

        const root = document.documentElement;
        const vv = window.visualViewport;

        const apply = () => {
            // innerHeight 是布局视口（不含键盘），vv.height 是可视区（含键盘遮挡）
            const layoutH = window.innerHeight;
            const visibleH = vv ? vv.height : layoutH;
            const raw = layoutH - visibleH;
            const kb = raw > KB_THRESHOLD ? Math.round(raw) : 0;

            root.style.setProperty("--kb-height", `${kb}px`);
            document.body.classList.toggle("kb-open", kb > 0);

            // 供调试浮层读取
            (window as unknown as { __kbHeight?: number }).__kbHeight = kb;
        };

        apply();

        if (vv) {
            vv.addEventListener("resize", apply);
            vv.addEventListener("scroll", apply);
        }
        window.addEventListener("resize", apply);
        window.addEventListener("orientationchange", apply);

        return () => {
            if (vv) {
                vv.removeEventListener("resize", apply);
                vv.removeEventListener("scroll", apply);
            }
            window.removeEventListener("resize", apply);
            window.removeEventListener("orientationchange", apply);
            root.style.removeProperty("--kb-height");
            document.body.classList.remove("kb-open");
        };
    }, []);
}
