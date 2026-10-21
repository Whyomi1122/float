"use client";

/**
 * 在根布局挂载「真实可视高度」写入器。
 * 逻辑见 lib/use-viewport-height.ts。
 */

import { useEffect } from "react";
import { useViewportHeightVar } from "@/lib/use-viewport-height";

export function ViewportHeightSync() {
    useViewportHeightVar();

    /**
     * 给 body 打 .kb-open 标记，表示「键盘确实顶起来了」。
     * 为什么不用 :focus —— 安卓 Firefox 在键盘收起后输入框仍可能保留焦点，
     * 导致依赖 :focus 的样式永久生效（购物页底栏淡出后回不来）。
     * 这里直接量 visualViewport：高度比布局视口矮 120px 以上即认为键盘打开。
     */
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const sync = () => {
            const shrunk = window.innerHeight - vv.height > 120;
            document.body.classList.toggle("kb-open", shrunk);
        };
        sync();
        vv.addEventListener("resize", sync);
        vv.addEventListener("scroll", sync);
        window.addEventListener("resize", sync);
        return () => {
            vv.removeEventListener("resize", sync);
            vv.removeEventListener("scroll", sync);
            window.removeEventListener("resize", sync);
            document.body.classList.remove("kb-open");
        };
    }, []);

    return null;
}
