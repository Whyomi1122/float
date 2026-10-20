"use client";

/**
 * 在根布局挂载「真实可视高度」写入器。
 * 逻辑见 lib/use-viewport-height.ts。
 */

import { useViewportHeightVar } from "@/lib/use-viewport-height";

export function ViewportHeightSync() {
    useViewportHeightVar();
    return null;
}
