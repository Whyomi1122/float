"use client";

import React from "react";
import {
  Clock,
  BookOpen,
  Archive,
  Palette,
  Code2,
  ListTree,
  Layers,
  Music,
  MessageSquareText,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";

// ══════════════════════════════════════════════════════════
// 群像「功能」面板（TOOLS）
// 视觉对齐目标截图：浅灰底 → 大标题「功能」+ TOOLS 小字 →
// 白底圆角卡列表（深黑方角图标 + 中文主标题 + 英文副标题 + ›）→ 底部取消条。
//
// 字号策略（需求 1.4）：全部走 fs() → calc(Npx * var(--app-text-scale, 1))，
// 与「设置 → 主题 → 文字缩放」绑定；变量缺失时按 1 倍（即基准值）渲染。
// 主标题基准 15px，默认观感不过大也不过小。
// ══════════════════════════════════════════════════════════

/** 把像素基准值转成跟随全局文字缩放的 font-size */
function fs(px: number): string {
  return `calc(${px}px * var(--app-text-scale, 1))`;
}

export type EnsembleToolId =
  | "narration"
  | "time"
  | "worldbook"
  | "wrapup"
  | "palette"
  | "customCss"
  | "status"
  | "model"
  | "bgm";

export interface EnsembleToolItem {
  id: EnsembleToolId;
  /** 中文主标题 */
  label: string;
  /** 英文副标题（全大写、字距拉开，纯装饰用） */
  labelEn: string;
  Icon: LucideIcon;
  /** 是否可用；未接入的功能显示为不可点击态 */
  enabled?: boolean;
  /** 已生效时的提示（例如配色已自定义、CSS 已启用） */
  active?: boolean;
}

/** 面板条目定义。顺序与目标截图一致。 */
export const ENSEMBLE_TOOLS: EnsembleToolItem[] = [
  { id: "narration", label: "旁白与设定", labelEn: "NARRATION", Icon: MessageSquareText, enabled: true },
  { id: "time", label: "时间感知", labelEn: "TIME AWARENESS", Icon: Clock, enabled: false },
  { id: "worldbook", label: "世界书", labelEn: "WORLD BOOK", Icon: BookOpen, enabled: false },
  { id: "wrapup", label: "杀青归档", labelEn: "WRAP UP", Icon: Archive, enabled: false },
  { id: "palette", label: "卡片配色", labelEn: "RECEIPT COLOR", Icon: Palette, enabled: true },
  { id: "customCss", label: "自定义 CSS", labelEn: "CUSTOM STYLE", Icon: Code2, enabled: true },
  { id: "status", label: "状态面板", labelEn: "STATUS PANEL", Icon: ListTree, enabled: false },
  { id: "model", label: "模型切换", labelEn: "API · SESSION", Icon: Layers, enabled: true },
  { id: "bgm", label: "网易云配乐", labelEn: "NETEASE BGM", Icon: Music, enabled: false },
];

function ToolRow({
  item,
  onClick,
}: {
  item: EnsembleToolItem;
  onClick: (id: EnsembleToolId) => void;
}) {
  const { Icon, label, labelEn, enabled, active } = item;
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && onClick(item.id)}
      className={`w-full flex items-center gap-3.5 px-3.5 py-3.5 rounded-[16px] text-left transition-all duration-200 ${
        enabled
          ? "bg-white active:scale-[0.985] shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
          : "bg-white/55"
      }`}
    >
      {/* 深黑方角图标 */}
      <span
        className={`w-11 h-11 rounded-[13px] shrink-0 grid place-items-center ${
          enabled ? "bg-[#111111]" : "bg-black/20"
        }`}
      >
        <Icon size={19} strokeWidth={1.9} className="text-white" />
      </span>

      <span className="flex-1 min-w-0">
        <span
          className={`block font-semibold tracking-tight leading-tight ${
            enabled ? "text-[#111111]" : "text-black/30"
          }`}
          style={{ fontSize: fs(15) }}
        >
          {label}
        </span>
        <span
          className={`block tracking-[0.16em] font-medium mt-1 ${
            enabled ? "text-black/30" : "text-black/15"
          }`}
          style={{ fontSize: fs(9.5) }}
        >
          {labelEn}
        </span>
      </span>

      {active && (
        <span className="w-1.5 h-1.5 rounded-full bg-[#111111] shrink-0 mr-1" />
      )}
      <ChevronRight
        size={18}
        strokeWidth={1.9}
        className={enabled ? "text-black/25 shrink-0" : "text-black/10 shrink-0"}
      />
    </button>
  );
}

/**
 * 底部升起的「功能」面板。
 * 纯展示 + 回调，不做任何数据读写，保持组件可复用。
 */
export function EnsembleToolsSheet({
  open,
  onClose,
  onPick,
  activeIds,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: EnsembleToolId) => void;
  /** 已生效的功能，用来点亮行末小圆点 */
  activeIds?: EnsembleToolId[];
}) {
  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px] animate-[fadeIn_180ms_ease-out]" />

      {/* 面板本体：从底部升起 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#f2f2f4] rounded-t-[26px] px-4 pt-6 pb-4 max-h-[86%] overflow-y-auto animate-[sheetUp_260ms_cubic-bezier(0.22,1,0.36,1)]"
      >
        {/* 标题区 */}
        <div className="px-1.5 mb-5">
          <div
            className="font-bold tracking-tight text-[#111111] leading-none"
            style={{ fontSize: fs(26) }}
          >
            功能
          </div>
          <div
            className="tracking-[0.28em] font-medium text-black/30 mt-2"
            style={{ fontSize: fs(10) }}
          >
            TOOLS
          </div>
        </div>

        {/* 条目列表 */}
        <div className="space-y-2.5">
          {ENSEMBLE_TOOLS.map((item) => (
            <ToolRow
              key={item.id}
              item={{ ...item, active: activeIds?.includes(item.id) }}
              onClick={onPick}
            />
          ))}
        </div>

        {/* 取消条 */}
        <button
          type="button"
          onClick={onClose}
          className="w-full mt-3 py-3.5 rounded-[16px] bg-white/70 font-medium text-black/55 active:scale-[0.985] transition-transform"
          style={{ fontSize: fs(14) }}
        >
          取消
        </button>

        {/* 动画关键帧（就近声明，避免污染全局样式表） */}
        <style jsx>{`
          @keyframes fadeIn {
            from {
              opacity: 0;
            }
            to {
              opacity: 1;
            }
          }
          @keyframes sheetUp {
            from {
              transform: translateY(100%);
            }
            to {
              transform: translateY(0);
            }
          }
        `}</style>
      </div>
    </div>
  );
}

export default EnsembleToolsSheet;
