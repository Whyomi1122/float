"use client";

/**
 * 把真实可视高度写进 `--app-vh`。
 *
 * 为什么需要它：
 *   移动端 `100lvh` 是「浏览器工具条收起时的最大高度」，比当前可见高度还大。
 *   实测 Chrome / Edge Android：可视高度 668~716，而 100lvh 算出 772。
 *   整个手机壳凭空高出 56~104px，`position:absolute; bottom:0` 的输入栏
 *   就被推到屏幕外面 —— 用户看到的现象是「聊天框看不见」。
 *
 * `visualViewport.height` 在键盘弹出时也会同步缩小，
 * 所以壳子会跟着收，贴底的输入栏自然贴在键盘上沿，不需要任何 translate 补偿。
 */

import { useEffect } from "react";

export function useViewportHeightVar(): void {
    useEffect(() => {
        if (typeof window === "undefined") return;

        const root = document.documentElement;
        let raf = 0;

        const apply = () => {
            const vv = window.visualViewport;
            const h = vv ? vv.height : window.innerHeight;
            if (!h || h < 100) return;
            root.style.setProperty("--app-vh", `${Math.round(h)}px`);
        };

        const schedule = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(() => {
                raf = 0;
                apply();
            });
        };

        apply();

        const vv = window.visualViewport;
        if (vv) {
            vv.addEventListener("resize", schedule);
            vv.addEventListener("scroll", schedule);
        }
        window.addEventListener("resize", schedule);
        window.addEventListener("orientationchange", schedule);

        return () => {
            if (raf) window.cancelAnimationFrame(raf);
            if (vv) {
                vv.removeEventListener("resize", schedule);
                vv.removeEventListener("scroll", schedule);
            }
            window.removeEventListener("resize", schedule);
            window.removeEventListener("orientationchange", schedule);
        };
    }, []);
}
