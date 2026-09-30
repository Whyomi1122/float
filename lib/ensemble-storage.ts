// lib/ensemble-storage.ts
// 群像模式（Ensemble）数据存储层
//
// v5.1：群像主视角不再自建 persona，直接复用设置里的“用户面具”(UserIdentity)。
// 因此本文件删除 EnsemblePersona / loadEnsemblePersonas / saveEnsemblePersonas /
// getDefaultPersona，personaId 字段语义 = UserIdentity.id。

import { kvGet, kvSet } from "./kv-db";
import { loadUserIdentities } from "./settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";

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
  /** = UserIdentity.id（设置里的用户面具 id），不再是群像自建 persona */
  personaId: string;
  cast: EnsembleCastMember[];
  turns: EnsembleTurn[];
  createdAt: string;
  updatedAt: string;
  maxTokensPerTurn?: number;
};

const STORAGE_KEY_SCRIPTS = "float_ensemble_scripts_v1";

/**
 * 群像主视角 = 设置里的用户面具列表。
 * 不再有群像私有的 persona 存储；面具的增删改全部在设置里完成。
 */
export function loadEnsemblePersonas(): UserIdentity[] {
  return loadUserIdentities();
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
