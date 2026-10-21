"use client";

/**
 * 在根布局挂载「真实可视高度」写入器。
 * 逻辑见 lib/use-viewport-height.ts。
 */

import { useEffect } from "react";
import { useViewportHeightVar } from "@/lib/use-viewport-height";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";

export function ViewportHeightSync() {
    useViewportHeightVar();
    useKeyboardInset();

    /**
     * 给 body 打 .kb-open 标记（键盘是否真的顶起来了）。
     *
     * 为什么不用 :focus —— 安卓 Firefox 在键盘收起后输入框仍可能保留焦点，
     * 依赖 :focus 的样式会永久生效（曾导致购物页底栏淡出后回不来）。
     * 现在由 useKeyboardInset 统一维护，这里只保留一个兜底清理。
     */
    useEffect(() => {
        return () => {
            document.body.classList.remove("kb-open");
        };
    }, []);

    return null;
}
