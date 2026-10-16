"use client";

import { useEffect } from "react";

const HIDDEN_ATTR = "data-chat-reasoning-hidden-by-setting";

function getSessionId(wrapper: HTMLElement): string | null {
  for (const className of Array.from(wrapper.classList)) {
    if (className.startsWith("session-") && className.length > "session-".length) {
      return className.slice("session-".length);
    }
  }
  return null;
}

function readHidden(_sessionId: string): boolean {
  // 「隐藏思维链」写死为常开。
  return true;
}

function forceHide(element: HTMLElement): void {
  if (element.hasAttribute(HIDDEN_ATTR)) return;
  element.setAttribute(HIDDEN_ATTR, "");
  element.style.setProperty("display", "none", "important");
}

function restoreHidden(element: HTMLElement): void {
  if (!element.hasAttribute(HIDDEN_ATTR)) return;
  element.style.removeProperty("display");
  element.removeAttribute(HIDDEN_ATTR);
}

function applyReasoningVisibility(wrapper: HTMLElement, hidden: boolean): void {
  if (!hidden) {
    wrapper.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach(restoreHidden);
    return;
  }

  // 普通消息：隐藏整条思维链入口；纯思维链轮次连外层一起隐藏，避免残留 gap。
  wrapper
    .querySelectorAll<HTMLElement>(
      ".chat-reasoning-trigger, [data-reasoning-row], [data-reasoning-only], [data-reasoning-empty]",
    )
    .forEach(forceHide);

  // 若用户在弹窗打开时切换设置，也一并强制隐藏整个思维链弹层。
  wrapper.querySelectorAll<HTMLElement>(".chat-reasoning-sheet").forEach((sheet) => {
    const overlay = sheet.closest<HTMLElement>(".modal-overlay");
    forceHide(overlay ?? sheet);
  });
}

function syncAll(): void {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>(".chat-room-wrapper"));
  wrappers.forEach((wrapper) => {
    const sessionId = getSessionId(wrapper);
    if (!sessionId) return;
    applyReasoningVisibility(wrapper, readHidden(sessionId));
  });
}

/**
 * 给聊天信息页补一个“隐藏思维链”开关。
 *
 * 这里故意在 DOM 层用 inline `display:none !important` 执行隐藏：
 * 会话自定义 CSS 来自 author stylesheet，优先级低于 inline !important，
 * 因此用户即使在自定义 CSS 里强制显示思维链，也无法覆盖这个隐私开关。
 * 关闭后移除 inline 样式，完整恢复项目原有 UI 与用户自己的 CSS 行为。
 */
export function ChatReasoningVisibilityController() {
  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncAll();
      });
    };

    syncAll();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach(restoreHidden);
    };
  }, []);

  return null;
}
