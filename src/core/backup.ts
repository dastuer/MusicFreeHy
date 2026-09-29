import { getDefaultStore } from "jotai";
import { invalidatePluginCache } from "./ipc";
import { pluginHost, IBackupPlugin } from "./pluginHost";
import {
    getUserSheets,
    saveSheets,
    ensureLikesSheet,
    mediaKey,
    LIKES_SHEET_ID,
    likesVersionAtom,
    sheetsVersionAtom,
    IUserSheet,
} from "./musicSheet";
import { setTheme } from "./theme";
import { notifyDefaultPluginHashChanged } from "./mediaSource";
import { TrackPlayerSingleton } from "./trackPlayer";
import { uploadBackupToWebdav, downloadBackupFromWebdav } from "./dav";
import { netFetchText } from "./net";

/**
 * 备份与恢复（Pad 版）
 *
 * 备份文件结构与 MusicFreeDesktop 完全一致：
 * {
 *   format: "musicfree-desktop",
 *   version: 1,
 *   musicSheets: IUserSheet[]（含固定 id 的「我喜欢的音乐」）,
 *   plugins: IBackupPlugin[]（无 srcUrl 的本地插件内嵌源码）,
 *   localMusic: []（Pad 不支持本地音乐，恒为空）,
 *   appConfig: {},
 *   preferences: { <localStorage 白名单键>: <原样字符串> }
 * }
 *
 * 桌面端导出的备份可以直接在 Pad 上恢复，反之亦然。
 * 范围约定：最近播放（musicHistory）不参与备份与恢复，与桌面端一致。
 */

/** 恢复模式，语义与 MusicFree 移动端/桌面端一致 */
export type ResumeMode = "append" | "overwrite-default" | "overwrite";

export const RESUME_MODE_OPTIONS: { value: ResumeMode; label: string; desc: string }[] = [
    {
        value: "append",
        label: "追加",
        desc: "同 id 歌单把备份里的歌曲补进来，本机已有的歌曲不动",
    },
    {
        value: "overwrite-default",
        label: "覆盖默认歌单",
        desc: "只有「我喜欢的音乐」被整体替换，其余歌单按追加处理",
    },
    {
        value: "overwrite",
        label: "完整覆盖",
        desc: "丢弃本机全部歌单，完全使用备份内容（不可撤销，最近播放不受影响）",
    },
];

const RESUME_MODE_KEY = "backup.resumeMode";

export function getResumeMode(): ResumeMode {
    const saved = localStorage.getItem(RESUME_MODE_KEY);
    if (saved === "append" || saved === "overwrite-default" || saved === "overwrite") {
        return saved;
    }
    return "append";
}

export function setResumeMode(mode: ResumeMode) {
    localStorage.setItem(RESUME_MODE_KEY, mode);
}

export function resumeModeLabel(mode: ResumeMode): string {
    return RESUME_MODE_OPTIONS.find((it) => it.value === mode)?.label ?? "追加";
}

/** ---------- 类型 ---------- */

export interface IBackupPayload {
    format?: string;
    version?: number;
    appVersion?: string;
    createdAt?: number;
    musicSheets?: any[];
    plugins?: any[];
    /** 老备份文件里的历史字段，只读兼容用，恢复时忽略 */
    musicHistory?: any[];
    localMusic?: any[];
    appConfig?: Record<string, any>;
    preferences?: Record<string, string>;
}

export interface ISheetResumeStats {
    created: number;
    merged: number;
    replaced: number;
    songsAdded: number;
    nameOnly: number;
}

export interface IPluginResumeResult {
    installed: number;
    updated: number;
    skipped: number;
    failed: { platform: string; reason: string }[];
}

export interface IResumeSummary {
    sheets: ISheetResumeStats;
    plugins: IPluginResumeResult;
    localMusic: number;
    appConfig: number;
    preferences: Record<string, string> | null;
    warnings: string[];
}

export const BACKUP_FORMAT = "musicfree-desktop";
export const BACKUP_VERSION = 1;
export const APP_VERSION = "1.0.0";

/** ---------- localStorage 偏好白名单（与桌面端完全一致） ---------- */

const PREF_KEYS = [
    "theme",
    "defaultQuality",
    "volume",
    "repeatMode",
    "playList",
    "currentMusic",
    "defaultPluginHash",
    "searchHistory",
    "playProgress",
    "rememberProgress",
];

// 音源设置只备份 defaultPluginHash；会话内手动切换的全局音源不持久化
const PREF_PREFIXES: string[] = [];

function collectPreferences(): Record<string, string> {
    const prefs: Record<string, string> = {};
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key) {
                continue;
            }
            if (!PREF_KEYS.includes(key) && !PREF_PREFIXES.some((p) => key.startsWith(p))) {
                continue;
            }
            const value = localStorage.getItem(key);
            if (value !== null) {
                prefs[key] = value;
            }
        }
    } catch {
        // localStorage 不可用时跳过偏好
    }
    return prefs;
}

function applyPreferences(prefs: Record<string, string> | null | undefined): string[] {
    if (!prefs || typeof prefs !== "object") {
        return [];
    }
    const written: string[] = [];
    for (const [key, value] of Object.entries(prefs)) {
        if (typeof value !== "string") {
            continue;
        }
        if (!PREF_KEYS.includes(key) && !PREF_PREFIXES.some((p) => key.startsWith(p))) {
            continue;
        }
        try {
            localStorage.setItem(key, value);
            written.push(key);
        } catch {
            // 单个键写失败不影响其他
        }
    }
    if (written.includes("defaultPluginHash")) {
        // 绕过 mediaSource 直接写入，通知订阅组件（音源面板/插件管理页）刷新
        notifyDefaultPluginHashChanged();
    }
    return written;
}

/** 恢复后让界面反映新数据 */
function refreshAfterRestore(prefs?: Record<string, string> | null) {
    invalidatePluginCache();
    const store = getDefaultStore();
    store.set(likesVersionAtom, store.get(likesVersionAtom) + 1);
    store.set(sheetsVersionAtom, store.get(sheetsVersionAtom) + 1);
    try {
        if (prefs?.theme) {
            setTheme(prefs.theme as any);
        }
        if (prefs?.volume !== undefined) {
            const volume = Number(prefs.volume);
            if (Number.isFinite(volume)) {
                TrackPlayerSingleton.setVolume(volume);
            }
        }
    } catch {
        // 立即生效失败不影响已写入的偏好
    }
}

/** ---------- 备份 ---------- */

export interface IBackupCounts {
    sheets: number;
    songs: number;
    plugins: number;
}

export async function getBackupCounts(): Promise<IBackupCounts> {
    const sheets = getUserSheets();
    const plugins = await pluginHost.backupPlugins();
    return {
        sheets: sheets.length,
        songs: sheets.reduce((acc, it) => acc + (it.musicList?.length ?? 0), 0),
        plugins: plugins.length,
    };
}

/** 组装备份数据（结构对齐桌面端 backupService.collect()） */
export async function collectBackup(): Promise<IBackupPayload> {
    ensureLikesSheet();
    const musicSheets = getUserSheets();
    const plugins = await pluginHost.backupPlugins();
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        appVersion: APP_VERSION,
        createdAt: Date.now(),
        musicSheets,
        plugins,
        localMusic: [],
        appConfig: {},
        preferences: collectPreferences(),
    };
}

/** 导出备份文件（浏览器下载） */
export async function exportBackupToLocal(): Promise<IBackupResult> {
    try {
        const payload = await collectBackup();
        const content = JSON.stringify(payload);
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        a.href = url;
        a.download = `MusicFreeBackup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
            now.getDate(),
        )}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        const sizeText =
            blob.size > 1024 * 1024
                ? `${(blob.size / 1024 / 1024).toFixed(1)} MB`
                : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
        return { success: true, sizeText };
    } catch (e: any) {
        return { success: false, message: e?.message ?? "导出失败" };
    }
}

export interface IBackupResult {
    success: boolean;
    message?: string;
    sizeText?: string;
}

/** ---------- 恢复 ---------- */

function parsePayload(payload: IBackupPayload | string): IBackupPayload {
    let data: any = payload;
    if (typeof payload === "string") {
        try {
            data = JSON.parse(payload);
        } catch {
            throw new Error("备份文件不是有效的 JSON");
        }
    }
    if (!data || typeof data !== "object") {
        throw new Error("备份内容为空");
    }
    const known = ["musicSheets", "plugins", "musicHistory", "localMusic", "preferences"];
    if (!known.some((k) => data[k] !== undefined)) {
        throw new Error("不是有效的备份文件");
    }
    if (data.format && data.format !== BACKUP_FORMAT) {
        console.warn("[backup] 备份 format 不是 musicfree-desktop，尝试继续恢复");
    }
    return data;
}

/** 兼容移动端备份：只有歌单名没有歌曲列表时按 nameOnly 恢复 */
function normalizeSheet(rawSheet: any): { sheet: IUserSheet | null; nameOnly: boolean } {
    if (!rawSheet || typeof rawSheet !== "object" || typeof rawSheet.title !== "string") {
        return { sheet: null, nameOnly: false };
    }
    const base: IUserSheet = {
        id: typeof rawSheet.id === "string" && rawSheet.id ? rawSheet.id : `restored-${Math.random().toString(36).slice(2, 10)}`,
        title: rawSheet.title,
        createAt: Number(rawSheet.createAt) || Date.now(),
        musicList: [],
    };
    if (Array.isArray(rawSheet.musicList)) {
        base.musicList = rawSheet.musicList.filter(
            (it: any) => it && typeof it === "object" && it.id !== undefined && it.platform,
        );
        return { sheet: base, nameOnly: false };
    }
    return { sheet: base, nameOnly: true };
}

export async function restoreBackup(
    payload: IBackupPayload | string,
    mode: ResumeMode = getResumeMode(),
): Promise<{ summary: IResumeSummary }> {
    const data = parsePayload(payload);
    const warnings: string[] = [];

    /** ---------- 歌单 ---------- */
    const sheetsStats: ISheetResumeStats = {
        created: 0,
        merged: 0,
        replaced: 0,
        songsAdded: 0,
        nameOnly: 0,
    };

    const backupSheetsRaw = Array.isArray(data.musicSheets) ? data.musicSheets : [];
    const normalized: { sheet: IUserSheet; nameOnly: boolean }[] = [];
    for (const raw of backupSheetsRaw) {
        const { sheet, nameOnly } = normalizeSheet(raw);
        if (!sheet) {
            continue;
        }
        normalized.push({ sheet, nameOnly });
        if (nameOnly) {
            sheetsStats.nameOnly += 1;
        }
    }

    ensureLikesSheet();
    let currentSheets = getUserSheets();

    const applySongsToSheet = (sheet: IUserSheet, incoming: IMusic.IMusicItem[]) => {
        const seen = new Set((sheet.musicList ?? []).map(mediaKey));
        const seenIncoming = new Set<string>();
        let added = 0;
        for (const item of incoming) {
            const key = mediaKey(item);
            if (seen.has(key) || seenIncoming.has(key)) {
                continue;
            }
            seenIncoming.add(key);
            sheet.musicList.unshift(item);
            added += 1;
        }
        sheetsStats.songsAdded += added;
        return added;
    };

    if (mode === "overwrite") {
        const nextSheets: IUserSheet[] = [];
        for (const { sheet, nameOnly } of normalized) {
            if (nameOnly) {
                continue;
            }
            nextSheets.push(sheet);
        }
        // 我喜欢的音乐无论如何都要存在
        if (!nextSheets.some((it) => it.id === LIKES_SHEET_ID)) {
            nextSheets.unshift({
                id: LIKES_SHEET_ID,
                title: "我喜欢的音乐",
                createAt: 0,
                musicList: [],
            });
        }
        saveSheets(nextSheets);
        sheetsStats.replaced = currentSheets.length;
        sheetsStats.songsAdded = nextSheets.reduce((acc, it) => acc + it.musicList.length, 0);
        currentSheets = nextSheets;
    } else {
        for (const { sheet: incoming, nameOnly } of normalized) {
            if (nameOnly) {
                const existing = currentSheets.find((it) => it.id === incoming.id);
                if (!existing) {
                    currentSheets.unshift({ ...incoming, musicList: [] });
                    sheetsStats.created += 1;
                }
                continue;
            }
            const existing =
                currentSheets.find((it) => it.id === incoming.id) ??
                (incoming.id === LIKES_SHEET_ID ? ensureLikesSheet() : undefined);
            if (existing) {
                if (mode === "overwrite-default" && existing.id === LIKES_SHEET_ID) {
                    existing.musicList = incoming.musicList;
                    sheetsStats.replaced += 1;
                    sheetsStats.songsAdded += existing.musicList.length;
                } else {
                    applySongsToSheet(existing, incoming.musicList);
                    sheetsStats.merged += 1;
                }
            } else {
                currentSheets.unshift(incoming);
                sheetsStats.created += 1;
                sheetsStats.songsAdded += incoming.musicList.length;
            }
        }
        saveSheets(currentSheets);
    }

    // Pad 不支持本地音乐：备份里的 localMusic 忽略并给出提示
    if (Array.isArray(data.localMusic) && data.localMusic.length) {
        warnings.push(`本设备不支持本地音乐，已跳过 ${data.localMusic.length} 首`);
    }

    /** ---------- 插件 ---------- */
    const pluginResult = await pluginHost.resumePlugins(
        (Array.isArray(data.plugins) ? data.plugins : []) as IBackupPlugin[],
    );

    /** ---------- 偏好 ---------- */
    const writtenPrefs = applyPreferences(data.preferences);

    refreshAfterRestore(data.preferences);

    return {
        summary: {
            sheets: sheetsStats,
            plugins: pluginResult,
            localMusic: 0,
            appConfig: 0,
            preferences: writtenPrefs.length ? data.preferences ?? null : null,
            warnings,
        },
    };
}

/** 从本地文件恢复（浏览器文件选择） */
export async function importBackupFromLocal(
    file: File,
    mode: ResumeMode = getResumeMode(),
) {
    const content = await file.text();
    return restoreBackup(content, mode);
}

/** 备份到 WebDAV（与桌面端同一账号即可互传，文件路径可在设置里指向桌面端的备份文件） */
export async function exportBackupToWebdav(): Promise<IBackupResult & { remotePath?: string }> {
    const payload = await collectBackup();
    const { remotePath } = await uploadBackupToWebdav(JSON.stringify(payload));
    return { success: true, remotePath };
}

/** 从 WebDAV 恢复 */
export async function importBackupFromWebdav(mode: ResumeMode = getResumeMode()) {
    const { content, remotePath } = await downloadBackupFromWebdav();
    const { summary } = await restoreBackup(content, mode);
    return { summary, remotePath };
}

/** 从 URL 恢复 */
export async function importBackupFromUrl(url: string, mode: ResumeMode = getResumeMode()) {
    const content = await netFetchText(url, 60000);
    const { summary } = await restoreBackup(content, mode);
    return { summary };
}

/** ---------- 展示辅助 ---------- */

export function describeResumeSummary(summary: IResumeSummary): string {
    const parts: string[] = [];
    const { sheets, plugins } = summary;

    if (sheets.created || sheets.merged || sheets.replaced) {
        const bits: string[] = [];
        if (sheets.created) {
            bits.push(`新增 ${sheets.created}`);
        }
        if (sheets.merged) {
            bits.push(`合并 ${sheets.merged}`);
        }
        if (sheets.replaced) {
            bits.push(`覆盖 ${sheets.replaced}`);
        }
        parts.push(`歌单 ${bits.join(" / ")}，补入 ${sheets.songsAdded} 首`);
    }

    if (plugins.installed || plugins.updated || plugins.skipped) {
        const bits: string[] = [];
        if (plugins.installed) {
            bits.push(`新增 ${plugins.installed}`);
        }
        if (plugins.updated) {
            bits.push(`更新 ${plugins.updated}`);
        }
        if (plugins.skipped) {
            bits.push(`已是最新 ${plugins.skipped}`);
        }
        parts.push(`音源 ${bits.join(" / ")}`);
    }

    if (plugins.failed.length) {
        // 恢复失败的音源点名并带原因：对应平台的歌没法播，用户需要知道去补装哪个
        const detail = plugins.failed
            .slice(0, 2)
            .map((f) => `${f.platform || "未知"}：${f.reason ?? "未知原因"}`)
            .join("；");
        parts.push(
            `${plugins.failed.length} 个音源恢复失败（${detail}${
                plugins.failed.length > 2 ? " 等" : ""
            }）`,
        );
    }

    if (summary.warnings.length) {
        return `恢复完成：${parts.join("；")}。${summary.warnings.join("；")}`;
    }

    if (!parts.length) {
        return "备份中没有可恢复的内容";
    }
    return `恢复完成：${parts.join("；")}`;
}
