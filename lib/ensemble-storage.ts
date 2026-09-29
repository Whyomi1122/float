// lib/ensemble-storage.ts
// 群像模式（Ensemble）数据存储层

import { kvGet, kvSet } from "./kv-db";
import { resolveUserIdentity } from "./settings-storage";

export type EnsemblePersona = {
  id: string;
  name: string;
  identityTag?: string; // 例如: 学生 / 双重人格 / 侦探
  avatarUrl?: string;
  description?: string;
};

export type EnsembleCastMember = {
  characterId: string;
  roleNote?: string;
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
  rawText?: string;
};

export type EnsembleScript = {
  id: string;
  title: string;
  personaId: string;
  cast: EnsembleCastMember[];
  turns: EnsembleTurn[];
  createdAt: string;
  updatedAt: string;
  maxTokensPerTurn?: number;
};

const STORAGE_KEY_SCRIPTS = "float_ensemble_scripts_v1";
const STORAGE_KEY_PERSONAS = "float_ensemble_personas_v1";

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

export function loadEnsemblePersonas(): EnsemblePersona[] {
  try {
    const data = kvGet<EnsemblePersona[]>(STORAGE_KEY_PERSONAS);
    if (data && Array.isArray(data) && data.length > 0) return data;
  } catch {}
  return getDefaultPersona();
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
