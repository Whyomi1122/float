// lib/memory-storage.ts
// IndexedDB persistence for long-term memory entries + short-term events + localStorage config.

import type { MemoryEntry, MemoryConfig, MemoryDraft } from "./memory-types";
import { DEFAULT_MEMORY_CONFIG } from "./memory-types";
import { kvGet, kvSet, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

// ── Long-term memory DB (unchanged from v1) ──

const DB_NAME = "ai_phone_memory_db_v1";
const DB_VERSION = 3;
const STORE_NAME = "memories";

const CONFIG_KEY = "ai_phone_memory_config_v1";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureMemoryIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_created")) {
        store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    }
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        } else {
            store = tx!.objectStore(STORE_NAME);
        }
        ensureMemoryIndexes(store);
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ── Long-term Entry CRUD ──

export async function saveMemoryEntry(entry: MemoryEntry): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index("by_character");
            entries = await runRequest(idx.getAll(characterId));
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId);
        }
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return entries;
    } finally {
        db.close();
    }
}

export async function loadMemoryEntriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return entries.filter(entry => entry.type === type);
}

export async function deleteMemoryEntry(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteMemoryEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {
            store.delete(id);
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteCharacterMemories(characterId: string): Promise<void> {
    const entries = await loadMemoryEntries(characterId);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function deleteCharacterMemoriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<void> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function getAllCharacterIdsWithMemories(): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const entries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
        const ids = new Set<string>();
        for (const e of entries) ids.add(e.characterId);
        return Array.from(ids);
    } finally {
        db.close();
    }
}

export async function getMemoryCount(characterId: string): Promise<number> {
    const entries = await loadMemoryEntries(characterId);
    return entries.length;
}

export async function getMemoryCountByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<number> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    return entries.length;
}

// ── Config (localStorage for fast sync access) ──

export function loadMemoryConfig(): MemoryConfig {
    if (typeof window === "undefined") return { ...DEFAULT_MEMORY_CONFIG };
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_MEMORY_CONFIG };
        return { ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_MEMORY_CONFIG };
    }
}

export function saveMemoryConfig(config: MemoryConfig): void {
    if (typeof window === "undefined") return;
    kvSet(CONFIG_KEY, JSON.stringify(config));
}

// ── Per-character event counter (localStorage) ──

const EVENT_COUNTER_PREFIX = "ai_phone_mem_evt_count_";
const LAST_SUMMARY_TS_PREFIX = "ai_phone_mem_last_sum_";
const CORE_COUNTER_PREFIX = "ai_phone_mem_core_count_";
const LAST_CORE_SUMMARY_TS_PREFIX = "ai_phone_mem_last_core_sum_";
registerKvMigration(CONFIG_KEY);
registerDynamicPrefix(EVENT_COUNTER_PREFIX);
registerDynamicPrefix(LAST_SUMMARY_TS_PREFIX);
registerDynamicPrefix(CORE_COUNTER_PREFIX);
registerDynamicPrefix(LAST_CORE_SUMMARY_TS_PREFIX);

export function getEventCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(EVENT_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementEventCounter(characterId: string): number {
    const next = getEventCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(EVENT_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetEventCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(EVENT_COUNTER_PREFIX + characterId, "0");
}

export function getLastSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getCoreMemoryCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(CORE_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementCoreMemoryCounter(characterId: string): number {
    const next = getCoreMemoryCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(CORE_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetCoreMemoryCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(CORE_COUNTER_PREFIX + characterId, "0");
}

export function getLastCoreSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CORE_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastCoreSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CORE_SUMMARY_TS_PREFIX + characterId, ts);
}

// ── 归档草稿（pending，存 KV，不混入正式记忆库）──

const DRAFTS_PREFIX = "ai_phone_mem_drafts_";
registerDynamicPrefix(DRAFTS_PREFIX);

export function loadMemoryDrafts(characterId: string): MemoryDraft[] {
    if (typeof window === "undefined") return [];
    const raw = kvGet(DRAFTS_PREFIX + characterId);
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? (arr as MemoryDraft[]) : [];
    } catch {
        return [];
    }
}

export function saveMemoryDrafts(characterId: string, drafts: MemoryDraft[]): void {
    if (typeof window === "undefined") return;
    kvSet(DRAFTS_PREFIX + characterId, JSON.stringify(drafts));
}

export function addMemoryDraft(draft: MemoryDraft): void {
    if (typeof window === "undefined") return;
    const list = loadMemoryDrafts(draft.characterId);
    // 同一指纹已存在则覆盖（避免重复草稿堆积）
    const idx = list.findIndex(d => d.contentHash === draft.contentHash);
    if (idx >= 0) list[idx] = draft;
    else list.push(draft);
    saveMemoryDrafts(draft.characterId, list);
}

export function removeMemoryDraft(characterId: string, draftId: string): void {
    if (typeof window === "undefined") return;
    saveMemoryDrafts(characterId, loadMemoryDrafts(characterId).filter(d => d.id !== draftId));
}

export function clearMemoryDrafts(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(DRAFTS_PREFIX + characterId, JSON.stringify([]));
}

/** 列出所有存在草稿的角色 id */
export function getAllCharacterIdsWithDrafts(): string[] {
    if (typeof window === "undefined") return [];
    const ids: string[] = [];
    try {
        const keys = Object.keys(window.localStorage || {});
        for (const k of keys) {
            if (k.startsWith(DRAFTS_PREFIX)) {
                const cid = k.slice(DRAFTS_PREFIX.length);
                if (loadMemoryDrafts(cid).length > 0) ids.push(cid);
            }
        }
    } catch { /* ignore */ }
    return ids;
}

// ── 防污染·墓碑（deletedMemoryHashes 的便捷读写）──

export function getDeletedHashes(): string[] {
    const config = loadMemoryConfig();
    return Array.isArray(config.deletedMemoryHashes) ? config.deletedMemoryHashes : [];
}

export function addDeletedHash(characterId: string, hash: string): void {
    if (typeof window === "undefined" || !hash) return;
    const config = loadMemoryConfig();
    const existing = Array.isArray(config.deletedMemoryHashes) ? config.deletedMemoryHashes : [];
    // 墓碑按角色隔离，避免不同角色撞 hash
    const key = `${characterId}::${hash}`;
    if (existing.includes(key)) return;
    saveMemoryConfig({ ...config, deletedMemoryHashes: [...existing, key].slice(-2000) });
}

export function isHashedDeleted(characterId: string, hash: string): boolean {
    if (!hash) return false;
    return getDeletedHashes().includes(`${characterId}::${hash}`);
}
