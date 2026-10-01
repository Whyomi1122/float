// lib/ensemble-storage.ts
// 群像模式（Ensemble）数据存储层
//
// 约定：所有持久化都走 kv-db 的字符串 KV（kvGet 返回 string|null，kvSet 只接 string），
// 因此对象一律 JSON.stringify / JSON.parse，并对解析失败做兜底。

import { kvGet, kvSet } from "./kv-db";
import { resolveUserIdentity } from "./settings-storage";

export type EnsemblePersona = {
  id: string;
  name: string;
  identityTag?: string; // 例如: 学生 / 双重人格 / 侦探
  avatarUrl?: string;
  description?: string;
};

/** 剧本里的一个参演角色（快照：存下来即与角色本体解耦） */
export type EnsembleCastMember = {
  id: string;
  name: string;
  /** 与 Character.avatar 对齐（可能为 null） */
  avatar?: string | null;
  persona?: string;
};

export type EnsembleTurn = {
  id: string;
  senderType: "user" | "character" | "narration";
  senderId?: string;
  senderName: string;
  senderAvatar?: string;
  content: string;
  timestamp: string;
  tokens?: number;
  /** 生成这一幕所用的模型名（取自全局 API 配置），用于元信息 MODEL 行 */
  model?: string;
  rawText?: string;
};

export type EnsembleScript = {
  id: string;
  title: string;
  /**
   * 剧本全局旁白与背景设定（旁白弹窗保存到这里）。
   * ⚠️ 注意：这是「导演设定」，只注入 AI 提示词，绝不作为一幕显示在剧情区。
   * 与「旁白幕（narration turn）」是两套东西，切勿混用。
   */
  background?: string;
  /** 是否启用旁白（关闭时 background 不注入提示词，按钮置灰） */
  narrationEnabled?: boolean;
  personaId?: string;
  cast: EnsembleCastMember[];
  turns: EnsembleTurn[];
  createdAt: string;
  updatedAt: string;
  maxTokensPerTurn?: number;
  /**
   * 卡片配色（三色体系的自定义覆盖）。
   * 只覆盖颜色，不改结构；缺省则用 GS_COLORS 默认值。
   */
  palette?: {
    dial?: string;
    act?: string;
    inn?: string;
  };
  /**
   * 自定义 CSS：用户手写的样式，注入到剧本剧场根容器。
   * ⚠️ 仅在客户端渲染时注入，不做任何服务端求值。
   */
  customCss?: string;
  /**
   * 模型切换：当前剧本指定的 API 配置 id。
   * 缺省则走 resolveEnsembleApiConfig 的级联兜底。
   */
  apiConfigIdOverride?: string;
};

const STORAGE_KEY_SCRIPTS = "float_ensemble_scripts_v1";
const STORAGE_KEY_PERSONAS = "float_ensemble_personas_v1";

// ── 底层 JSON 读写（统一处理 kv 的 string 契约 + 异常兜底） ──

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = kvGet(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    kvSet(key, JSON.stringify(value));
  } catch (e) {
    console.warn("[ensemble-storage] write failed:", key, e);
  }
}

// 动态获取当前用户在小手机里的真实身份
function getDefaultPersona(): EnsemblePersona[] {
  const user = resolveUserIdentity();
  const userName = user?.name?.trim() || "观察者";
  return [
    {
      id: "persona_default",
      name: userName,
      identityTag: "本体",
      avatarUrl: user?.avatarUrl || "",
      description: "当前默认身份",
    },
  ];
}

// ── Personas ──

export function loadEnsemblePersonas(): EnsemblePersona[] {
  const data = readJson<EnsemblePersona[] | null>(STORAGE_KEY_PERSONAS, null);
  if (Array.isArray(data) && data.length > 0) return data;
  return getDefaultPersona();
}

export function saveEnsemblePersonas(personas: EnsemblePersona[]): void {
  writeJson(STORAGE_KEY_PERSONAS, personas);
}

// ── Scripts ──

export function loadEnsembleScripts(): EnsembleScript[] {
  const data = readJson<EnsembleScript[] | null>(STORAGE_KEY_SCRIPTS, null);
  return Array.isArray(data) ? data : [];
}

export function saveEnsembleScripts(scripts: EnsembleScript[]): void {
  writeJson(STORAGE_KEY_SCRIPTS, scripts);
}

export function saveOrUpdateEnsembleScript(script: EnsembleScript): void {
  const scripts = loadEnsembleScripts();
  const next = { ...script, updatedAt: new Date().toISOString() };
  const idx = scripts.findIndex((s) => s.id === script.id);
  if (idx >= 0) {
    scripts[idx] = next;
  } else {
    scripts.unshift(next);
  }
  saveEnsembleScripts(scripts);
}

export function deleteEnsembleScript(id: string): void {
  const scripts = loadEnsembleScripts().filter((s) => s.id !== id);
  saveEnsembleScripts(scripts);
}

/** 追加一幕，返回更新后的剧本（找不到则返回 null） */
export function appendEnsembleTurn(
  scriptId: string,
  turn: EnsembleTurn
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    turns: [...scripts[idx].turns, turn],
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}

/** 删除指定一幕，返回更新后的剧本（找不到则返回 null） */
export function deleteEnsembleTurn(
  scriptId: string,
  turnId: string
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    turns: scripts[idx].turns.filter((t) => t.id !== turnId),
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}

/** 替换指定一幕（用于重 roll / 编辑），返回更新后的剧本 */
export function updateEnsembleTurn(
  scriptId: string,
  turnId: string,
  patch: Partial<EnsembleTurn>
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    turns: scripts[idx].turns.map((t) =>
      t.id === turnId ? { ...t, ...patch } : t
    ),
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}
