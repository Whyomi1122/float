// lib/settings-db.ts
// IndexedDB persistence for presets, world books, and regex configs.
// Same pattern as chat-db.ts: in-memory cache + async fire-and-forget writes.

import Dexie from "dexie";
import type { PresetConfig, WorldBookConfig, RegexConfig } from "./settings-types";

// ── Database Schema ──────────────────────────────

class SettingsDatabase extends Dexie {
    presets!: Dexie.Table<PresetConfig, string>;
    worldBooks!: Dexie.Table<WorldBookConfig, string>;
    regexes!: Dexie.Table<RegexConfig, string>;

    constructor() {
        super("AiPhoneSettingsDB");
        this.version(1).stores({
            presets: "id",
            worldBooks: "id",
            regexes: "id",
        });
    }
}

const settingsDb = new SettingsDatabase();

// ── localStorage keys (for migration) ──

const LS_PRESETS_KEY = "ai_phone_presets_v1";
const LS_WORLDBOOKS_KEY = "ai_phone_worldbooks_v1";
const LS_REGEXES_KEY = "ai_phone_regexes_v1";
const LS_MIGRATED_FLAG = "ai_phone_settings_idb_migrated_v1";

// ── In-memory caches ──

let _presets: PresetConfig[] | null = null;
let _worldBooks: WorldBookConfig[] | null = null;
let _regexes: RegexConfig[] | null = null;
let _hydrated = false;
/** 正在进行的 hydrate（并发调用复用，避免重复读 IDB） */
let _hydratePromise: Promise<void> | null = null;
let _presetsWriteQueue: Promise<void> = Promise.resolve();

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Hydration (must be called once at startup) ──

export function hydrateSettingsDb(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    // 并发复用：多个入口（桌面壳 / 绑定页 / 自定义应用 bridge）会同时触发水合
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = doHydrate().finally(() => {
        if (!_hydrated) _hydratePromise = null; // 失败允许下次重试
    });
    return _hydratePromise;
}

async function doHydrate(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return;

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // Guard against a lost migration flag while IndexedDB still holds data.
        // The flag lives in volatile localStorage; the data lives in durable IDB and
        // can outlive the flag (e.g. clearing the "cache" data module). Re-migrating
        // from now-empty localStorage would shadow real data with empty caches and
        // the next write would wipe IDB — so reuse IDB data when it already exists.
        try {
            const existingCount =
                (await settingsDb.presets.count()) +
                (await settingsDb.worldBooks.count()) +
                (await settingsDb.regexes.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [presets, worldBooks, regexes] = await Promise.all([
                    settingsDb.presets.toArray(),
                    settingsDb.worldBooks.toArray(),
                    settingsDb.regexes.toArray(),
                ]);
                _presets = presets;
                _worldBooks = worldBooks;
                _regexes = regexes;
                _hydrated = true;
                console.log(`[SettingsDB] Migration flag missing but IndexedDB has data; reusing it: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
                return;
            }
        } catch (err) {
            console.warn("[SettingsDB] Pre-migration IndexedDB check failed:", err);
        }

        // Migrate from localStorage → IndexedDB
        try {
            const lsPresets: PresetConfig[] = safeParse(window.localStorage.getItem(LS_PRESETS_KEY));
            const lsWorldBooks: WorldBookConfig[] = safeParse(window.localStorage.getItem(LS_WORLDBOOKS_KEY));
            const lsRegexes: RegexConfig[] = safeParse(window.localStorage.getItem(LS_REGEXES_KEY));

            if (lsPresets.length > 0) await settingsDb.presets.bulkPut(lsPresets);
            if (lsWorldBooks.length > 0) await settingsDb.worldBooks.bulkPut(lsWorldBooks);
            if (lsRegexes.length > 0) await settingsDb.regexes.bulkPut(lsRegexes);

            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_PRESETS_KEY);
            window.localStorage.removeItem(LS_WORLDBOOKS_KEY);
            window.localStorage.removeItem(LS_REGEXES_KEY);

            console.log(`[SettingsDB] Migrated: ${lsPresets.length} presets, ${lsWorldBooks.length} worldBooks, ${lsRegexes.length} regexes`);

            _presets = lsPresets;
            _worldBooks = lsWorldBooks;
            _regexes = lsRegexes;
        } catch (err) {
            console.error("[SettingsDB] Migration failed, falling back to localStorage:", err);
            _presets = safeParse(window.localStorage.getItem(LS_PRESETS_KEY));
            _worldBooks = safeParse(window.localStorage.getItem(LS_WORLDBOOKS_KEY));
            _regexes = safeParse(window.localStorage.getItem(LS_REGEXES_KEY));
        }
    } else {
        // Already migrated: load from IndexedDB
        try {
            const [presets, worldBooks, regexes] = await Promise.all([
                settingsDb.presets.toArray(),
                settingsDb.worldBooks.toArray(),
                settingsDb.regexes.toArray(),
            ]);
            _presets = presets;
            _worldBooks = worldBooks;
            _regexes = regexes;
            console.log(`[SettingsDB] Loaded: ${presets.length} presets, ${worldBooks.length} worldBooks, ${regexes.length} regexes`);
        } catch (err) {
            // ⚠️ 失败时**不要**把缓存清空成 []：_worldBooks = [] 会让
            //    loadWorldBooks() 立刻返回空数组，而写回（writeWorldBooksCache）
            //    会把这个空快照 clear+bulkPut 进 IndexedDB —— 一次临时读失败
            //    就把用户真实的世界书全抹掉（格式导入「提示成功但实机看不到」即此）。
            //    改为「保持未知（null）」+ 只在本次会话内标记不水合：
            //    · readWorldBooksCache() 本就返回 _worldBooks ?? []，保持 null 只是空读，不误写
            //    · 下次调 hydrateSettingsDb() 会重试（此前这里失败也置 _hydrated=true，
            //      导致永久卡死在空缓存上）
            console.error("[SettingsDB] Failed to load from IndexedDB:", err);
            console.warn("[SettingsDB] Keeping in-memory caches unset (not empty) and allowing a later hydration retry.");
            migrateLegacyLocalStorage();
            return;
        }
    }
    // 水合成功后再补一次旧 key 迁移（新库为空时才会真正落数据）
    migrateLegacyLocalStorage();
    _hydrated = true;
}

export function isSettingsHydrated(): boolean {
    return _hydrated;
}

// ── Sync reads from cache ──

export function readPresetsCache(): PresetConfig[] {
    return _presets ?? [];
}

export function readWorldBooksCache(): WorldBookConfig[] {
    return _worldBooks ?? [];
}

export function readRegexesCache(): RegexConfig[] {
    return _regexes ?? [];
}

// ── Writes: update cache + async persist ──

// clear + bulkPut are wrapped in a single transaction so a crash/close between
// them can never leave the store emptied. (Matches dbReplaceContacts in chat-db.)
function persistPresetsSnapshot(presets: PresetConfig[]): Promise<void> {
    return settingsDb.transaction("rw", settingsDb.presets, async () => {
        await settingsDb.presets.clear();
        await settingsDb.presets.bulkPut(presets);
    });
}

function enqueuePresetsPersist(presets: PresetConfig[], warnInQueue: boolean): Promise<void> {
    const task = _presetsWriteQueue.then(() => persistPresetsSnapshot(presets));
    _presetsWriteQueue = task.catch(err => {
        if (warnInQueue) console.warn("[SettingsDB] save presets failed:", err);
    });
    return task;
}

export function writePresetsCache(presets: PresetConfig[]): void {
    // 同 writeWorldBooksCache：未水合时整包写会抹掉已有数据（旧逻辑只做增量
    // bulkPut，但缓存里的空快照一旦水合就会 clear+bulkPut，依旧会抹掉）。
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCache ignored before hydration (would clobber stored presets); retrying hydration.");
        void hydrateSettingsDb();
        return;
    }
    _presets = presets;
    void enqueuePresetsPersist(presets, true);
}

export async function writePresetsCacheAsync(presets: PresetConfig[]): Promise<void> {
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writePresetsCacheAsync ignored before hydration (would clobber stored presets); retrying hydration.");
        await hydrateSettingsDb();
        return;
    }
    _presets = presets;
    try {
        await enqueuePresetsPersist(presets, false);
    } catch (err) {
        console.warn("[SettingsDB] save presets failed:", err);
        throw err;
    }
}

export function writeWorldBooksCache(books: WorldBookConfig[]): void {
    // ⚠️ 未水合时**一律禁止整包写**：此时 `books` 多半是 `loadWorldBooks()`
    //    返回的 `_worldBooks ?? []`（因为没水合，一定是空数组）。
    //    旧逻辑只做 bulkPut（「增量写」），但那个空数组随后在同一个会话里
    //    一旦水合成功就会被当成快照 clear+bulkPut —— 依然会抹掉真实数据。
    //    正确做法：**丢弃这次写**（内存缓存都不更新），并推一次水合重试；
    //    等水合完成，用户的操作重新执行即可（读到的就是真实数据）。
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeWorldBooksCache ignored before hydration (would clobber stored world books); retrying hydration.");
        void hydrateSettingsDb();
        return;
    }
    _worldBooks = books;
    settingsDb.transaction("rw", settingsDb.worldBooks, async () => {
        await settingsDb.worldBooks.clear();
        await settingsDb.worldBooks.bulkPut(books);
    }).catch(err => console.warn("[SettingsDB] save worldBooks failed:", err));
}

export function writeRegexesCache(regexes: RegexConfig[]): void {
    // 同 writeWorldBooksCache：未水合时的整包写会抹掉已有正则。
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[SettingsDB] writeRegexesCache ignored before hydration (would clobber stored regexes); retrying hydration.");
        void hydrateSettingsDb();
        return;
    }
    _regexes = regexes;
    settingsDb.transaction("rw", settingsDb.regexes, async () => {
        await settingsDb.regexes.clear();
        await settingsDb.regexes.bulkPut(regexes);
    }).catch(err => console.warn("[SettingsDB] save regexes failed:", err));
}

// 旧 localStorage key（一次性迁移用）。这些 key 曾经由 kv-db 管理并被整个删除，
// 老用户若还留着这份数据，这里补一次迁移，避免永久丢失。
const LEGACY_LS_PRESETS_KEY = "ai_phone_presets";
const LEGACY_LS_WORLDBOOKS_KEY = "ai_phone_worldbooks";
const LEGACY_LS_REGEXES_KEY = "ai_phone_regexes";

/**
 * 把残留的旧 localStorage 世界书/预设/正则一次性并入缓存（幂等）。
 * 只在「新库确实还没有数据」时执行，避免旧快照覆盖新数据。
 */
function migrateLegacyLocalStorage(): void {
    if (typeof window === "undefined") return;
    try {
        for (const [key, apply] of [
            [LEGACY_LS_PRESETS_KEY, (items: unknown[]) => { if (!(_presets?.length)) _presets = items as PresetConfig[]; }],
            [LEGACY_LS_WORLDBOOKS_KEY, (items: unknown[]) => { if (!(_worldBooks?.length)) _worldBooks = items as WorldBookConfig[]; }],
            [LEGACY_LS_REGEXES_KEY, (items: unknown[]) => { if (!(_regexes?.length)) _regexes = items as RegexConfig[]; }],
        ] as const) {
            const raw = window.localStorage.getItem(key);
            if (!raw) continue;
            const items = safeParse(raw);
            if (!Array.isArray(items) || items.length === 0) continue;
            apply(items);
            console.log(`[SettingsDB] Migrated legacy localStorage key "${key}" (${items.length} items).`);
        }
    } catch (err) {
        console.warn("[SettingsDB] Legacy localStorage migration skipped:", err);
    }
}
