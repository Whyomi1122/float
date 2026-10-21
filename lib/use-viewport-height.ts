"use client";

/**
 * 把「键盘未弹出时的可视高度」写进 `--app-vh`。
 *
 * 为什么需要它：
 *   移动端 `100lvh` 是「浏览器工具条收起时的最大高度」，比当前可见高度还大。
 *   实测 Chrome / Edge Android：可视高度 668~716，而 100lvh 算出 772。
 *   整个手机壳凭空高出 56~104px，`position:absolute; bottom:0` 的输入栏
 *   就被推到屏幕外面 —— 用户看到的现象是「聊天框看不见」。
 *
 * 关键：这里【故意】忽略键盘引起的高度变化。
 *   旧实现直接用 visualViewport.height，键盘一弹壳子就收缩，带来三个副作用：
 *     1) 购物页整页变矮 → 底部导航被顶到键盘上方
 *     2) 剧情室消息列表可用高度变化、滚动边界算错 → 新消息被输入栏切掉
 *     3) 聊天室输入栏要等收缩完成才重排 → 键盘弹完才跳上来
 *   现在只记录「键盘没弹时」的高度，键盘遮挡交给 --kb-height / .kb-open 处理。
 */

import { useEffect } from "react";

/** 与 use-keyboard-inset 一致的判定阈值 */
const KB_THRESHOLD = 120;

export function useViewportHeightVar(): void {
    useEffect(() => {
        if (typeof window === "undefined") return;

        const root = document.documentElement;
        let raf = 0;
        /** 最近一次「键盘未弹出」时记录的高度，作为键盘弹起期间的稳定值 */
        let stableH = 0;

        const apply = () => {
            const vv = window.visualViewport;
            const h = vv ? vv.height : window.innerHeight;
            if (!h || h < 100) return;

            const layoutH = window.innerHeight;
            const kbOpen = layoutH - h > KB_THRESHOLD;

            if (!kbOpen) {
                // 正常状态（含地址栏收起/展开）：以实际可视高度为准
                stableH = h;
            } else if (!stableH) {
                // 首帧就是键盘弹出态：退回布局视口高度
                stableH = layoutH;
            }

            root.style.setProperty("--app-vh", `${Math.round(stableH)}px`);
        };

        /** 同步写入，避免多一帧延迟 */
        const schedule = () => {
            if (raf) {
                window.cancelAnimationFrame(raf);
                raf = 0;
            }
            apply();
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
