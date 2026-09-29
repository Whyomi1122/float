// lib/ensemble-storage.ts
// 群像模式（Ensemble）数据存储层

import { kvGet, kvSet } from "./kv-db";

export type EnsemblePersona = {
  id: string;
  name: string;
  identityTag?: string; // 例如: 学生 / 双重人格
  avatarUrl?: string;
  description?: string;
};

export type EnsembleCastMember = {
  characterId: string;
  roleNote?: string; // 参演备注设定
};

export type EnsembleTurn = {
  id: string;
  senderType: "user" | "character" | "narration";
  senderId?: string; // characterId 或 "user"
  senderName: string;
  senderAvatar?: string;
  content: string;
  timestamp: string;
  tokens?: number;
  rawText?: string;
};

export type EnsembleScript = {
  id: string;
  title: string; // 剧本标题，如 "句号不是结束"
  personaId: string; // 使用的我方 Persona
  cast: EnsembleCastMember[]; // 参演角色的 ID 列表
  turns: EnsembleTurn[]; // 剧情记录流
  createdAt: string;
  updatedAt: string;
  maxTokensPerTurn?: number; // 默认 1000
};

const STORAGE_KEY_SCRIPTS = "float_ensemble_scripts_v1";
const STORAGE_KEY_PERSONAS = "float_ensemble_personas_v1";

// 初始默认 Persona（可由用户自建）
const DEFAULT_PERSONAS: EnsemblePersona[] = [
  { id: "p_default", name: "岳霖玉", identityTag: "本体", description: "普通观察者与参与者" },
  { id: "p_student", name: "岳霖玉", identityTag: "学生", description: "高中生/大学生身份设定" },
];

export function loadEnsemblePersonas(): EnsemblePersona[] {
  try {
    const data = kvGet<EnsemblePersona[]>(STORAGE_KEY_PERSONAS);
    if (data && Array.isArray(data) && data.length > 0) return data;
  } catch {}
  return DEFAULT_PERSONAS;
}

export function saveEnsemblePersonas(personas: EnsemblePersona[]): void {
  kvSet(STORAGE_KEY_PERSONAS, personas);
}

export function loadEnsembleScripts(): EnsembleScript[] {
  try {
    const data = kvGet<EnsembleScript[]>(STORAGE_KEY_SCRIPTS);
    if (data && Array.isArray(data)) return data;
  } catch {}
  return [];
}

export function saveEnsembleScripts(scripts: EnsembleScript[]): void {
  kvSet(STORAGE_KEY_SCRIPTS, scripts);
}

export function getEnsembleScriptById(id: string): EnsembleScript | undefined {
  return loadEnsembleScripts().find((s) => s.id === id);
}

export function saveOrUpdateEnsembleScript(script: EnsembleScript): void {
  const scripts = loadEnsembleScripts();
  const idx = scripts.findIndex((s) => s.id === script.id);
  if (idx >= 0) {
    scripts[idx] = { ...script, updatedAt: new Date().toISOString() };
  } else {
    scripts.unshift({ ...script, updatedAt: new Date().toISOString() });
  }
  saveEnsembleScripts(scripts);
}

export function deleteEnsembleScript(id: string): void {
  const scripts = loadEnsembleScripts().filter((s) => s.id !== id);
  saveEnsembleScripts(scripts);
}
