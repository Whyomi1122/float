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
  /**
   * 是否启用双语语言格式（缺省关闭）。
   * 开启后：角色说非中文时，先正常写外语原句，紧跟（）补中文翻译。
   * 只作用于台词；动作/环境/心理一律正常写中文，不翻译。
   */
  bilingualEnabled?: boolean;
  personaId?: string;
  cast: EnsembleCastMember[];
  turns: EnsembleTurn[];
  createdAt: string;
  updatedAt: string;
  /**
   * 每轮输出长度（字数目标，给提示词用）。
   * 「功能 → 剧本设置」可调；缺省 500 字。
   * 实际请求的 token 上限由它换算（1 字 ≈ 1.6 token + 40% 余量），
   * 因此调这个值会同步放宽 max_tokens，不会出现「护栏比目标先到」的截断。
   */
  charsPerTurn?: number;
  /**
   * 每次请求要几个角色依次登场（群像核心参数，缺省 2）。
   * ⚠️ 这是「一轮里出现几个角色」而不是「一个角色写几个字」，
   * 二者完全解耦：字数再少也不需要砍角色。
   */
  actorsPerTurn?: number;
  /**
   * 每轮输出长度的 token 硬上限（高级项）。
   * 留空则由 charsPerTurn 自动换算；手动指定时会覆盖自动值。
   */
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
  /**
   * 模型切换：当前剧本在该 API 下指定的具体模型名。
   * 与 apiConfigIdOverride 配合：先定 API，再定模型。
   * ⚠️ 只覆盖本剧本，不回写全局设置的 defaultModel。
   */
  modelOverride?: string;
  /**
   * 时间感知：让 AI 知道「现在是几点」。
   * realtime=true 时注入真实系统时间；否则用 anchor 指定的虚拟时间锚点。
   */
  timeAwareness?: {
    enabled: boolean;
    /** true=跟随真实时间；false=使用下方虚拟锚点 */
    realtime: boolean;
    /** 虚拟时间锚点（ISO 字符串，realtime=false 时生效） */
    anchor?: string;
    /** 虚拟锚点的自然语言描述，例如「深冬的凌晨三点」 */
    anchorLabel?: string;
  };
  /**
   * 世界书：本剧本启用的全局世界书 id 列表。
   * ⚠️ 只存 id 引用，内容实时从「设置 → 世界书」读取，避免快照过期。
   */
  worldBookIds?: string[];
  /**
   * 杀青归档：已归档的剧情档案（增量式，可撤销）。
   * 每次归档压入一条，条目自带已覆盖到哪一幕的锚点。
   */
  archives?: EnsembleArchiveEntry[];
  /**
   * 状态面板：字段定义 + 模板（对齐图 3 的「字段时间 / 模板」两段式）。
   * 未启用时 AI 不生成状态数据。
   */
  statusPanel?: {
    enabled: boolean;
    fields: { key: string; desc: string; max?: number }[];
    template: string;
    /** 模板引擎：HTML/CSS/JS 全放开时为 "html" */
    engine: "html" | "text";
  };
};

/** 一次「杀青」归档的记录（支持撤销到上一版） */
export type EnsembleArchiveEntry = {
  id: string;
  createdAt: string;
  /** 归档覆盖到的最后一幕 id（用于增量：下次只归档这之后的新剧情） */
  lastTurnId?: string;
  /** 归档时已处理的幕数快照 */
  turnCount: number;
  /** 剧情档案正文（可编辑） */
  content: string;
  /** 生成这份档案用的模型名，便于「换个模型重来」 */
  model?: string;
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

/**
 * 只把某一幕的展示内容换掉（重 roll 翻页 / 删掉一版后切到相邻版用）。
 * ⚠️ 与 updateEnsembleTurn 的区别：这里**不走 Partial 语义**，只动 content/tokens，
 * 其余字段（model、timestamp 等）一律保留，避免翻页时把模型名改花。
 */
export function setTurnDisplayContent(
  scriptId: string,
  turnId: string,
  content: string
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    turns: scripts[idx].turns.map((t) =>
      t.id === turnId
        ? { ...t, content, tokens: Math.ceil(content.length * 1.3) }
        : t
    ),
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}

// ── 杀青归档（增量、可撤销） ──────────────────────────────

/** 追加一次归档记录，返回更新后的剧本 */
export function appendEnsembleArchive(
  scriptId: string,
  entry: EnsembleArchiveEntry
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    archives: [...(scripts[idx].archives ?? []), entry],
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}

/** 覆盖某一版归档正文（剧情档案可编辑） */
export function setArchiveContent(
  scriptId: string,
  archiveId: string,
  content: string
): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const updated: EnsembleScript = {
    ...scripts[idx],
    archives: (scripts[idx].archives ?? []).map((a) =>
      a.id === archiveId ? { ...a, content } : a
    ),
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}

/** 撤销上一次杀青（弹出最后一条归档，回到「未杀青」状态） */
export function undoLastEnsembleArchive(scriptId: string): EnsembleScript | null {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === scriptId);
  if (idx < 0) return null;
  const list = scripts[idx].archives ?? [];
  if (list.length === 0) return scripts[idx];
  const updated: EnsembleScript = {
    ...scripts[idx],
    archives: list.slice(0, -1),
    updatedAt: new Date().toISOString(),
  };
  scripts[idx] = updated;
  saveEnsembleScripts(scripts);
  return updated;
}
