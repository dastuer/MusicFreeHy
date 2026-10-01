import { atom, getDefaultStore } from "jotai";
import { callNativeMethod, isNative, localFileUrl } from "./native";
import {
    getDownloadSaveTarget,
    getDownloadSubfolder,
    getDownloadExternalDir,
    prettyAbsDir,
    writeAndroidFile,
    writeIosFile,
} from "./musicDownload";
import { getSortedSearchablePlugins, pluginCall, type SerializedPlugin } from "./ipc";
import { setLocalLyricResolver, TrackPlayerSingleton } from "./trackPlayer";
import { showToast } from "./uiAtoms";

/**
 * 本地音乐：扫描设备里的音频文件，形成可播放 / 可收藏 / 可删除的本地曲库。
 *
 * 目录来源（设置 → 下载 决定「应用的音乐下载目录」在哪）：
 *  - 默认（未自定义）：系统下载目录 + 应用的音乐下载目录（按保存位置自动跟随）；
 *  - 自定义后：完全以用户配置的目录列表为准，可随时「恢复默认」。
 *
 * 扫描实现按平台分流：
 *  - Android：LocalMusicPlugin（MediaStore + 目录遍历 + 标签解析 + 封面提取）；
 *  - iOS：走 Filesystem 插件遍历应用沙盒目录，时长用 <audio> 元数据探测；
 *  - 浏览器：不支持，入口仅做提示。
 *
 * 曲库记录存 localStorage（不含大体积内联数据，封面统一是文件路径），
 * localMusicVersionAtom 在记录变化后自增，驱动「本地音乐」页 / 「我的」页刷新。
 *
 * 「匹配歌词与封面」：逐首用音源插件搜索候选并打分取最优，歌词 / 封面
 * 下载到应用目录（Android filesDir、iOS DATA 下的 match_meta/），记录里存路径；
 * 支持暂停 / 继续 / 停止，进度经 matchTaskAtom 驱动页面顶部进度条；
 * 任务队列持久化到 localStorage，应用退出（进程被杀）后下次启动自动续跑。
 */

export const localMusicVersionAtom = atom(0);

/** 认作音频的扩展名（与原生插件保持一致） */
export const AUDIO_EXT_RE = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|ape)$/i;
/** 「短音频」的界限（秒） */
export const SHORT_AUDIO_SECONDS = 60;

const LIB_KEY = "localMusic.library";
const DIRS_KEY = "localMusic.scanDirs";
const SKIP_KEY = "localMusic.skipShort";

type DevicePlatform = "android" | "ios" | "web";

function currentPlatform(): DevicePlatform {
    if (!isNative()) {
        return "web";
    }
    try {
        const p = (window as any).Capacitor?.getPlatform?.();
        return p === "android" || p === "ios" ? p : "web";
    } catch {
        return "web";
    }
}

/** 当前平台（页面按它决定扫描目录的可编辑性 / 环境提示） */
export function localMusicPlatform(): DevicePlatform {
    return currentPlatform();
}

/* ---------- 曲库记录 ---------- */

export interface ILocalMusicRecord {
    /** = localPath（平台 + 文件路径即唯一键） */
    id: string;
    platform: "local";
    title: string;
    artist: string;
    album: string;
    /** 秒 */
    duration: number;
    /** 绝对路径（iOS 为沙盒内绝对路径），播放与详情都用它 */
    localPath: string;
    /** 字节 */
    size: number;
    /** 小写扩展名，如 mp3 / flac */
    format: string;
    /** kbps（iOS 扫描拿不到） */
    bitrate?: number;
    /** Hz（iOS 扫描拿不到） */
    sampleRate?: number;
    /** 秒 */
    mtime: number;
    /** 封面文件绝对路径（Android 扫描提取；可能被系统清缓存后失效，展示层自行回退） */
    artwork?: string;
    /** 匹配到的歌词文件绝对路径（「匹配歌词与封面」写入） */
    lyricPath?: string;
    /** 匹配到的封面文件绝对路径（优先于扫描提取的 artwork 展示） */
    matchedArtwork?: string;
    /** 匹配来源音源插件名 */
    matchedSource?: string;
    /** 最近一次匹配完成时间（秒） */
    matchedAt?: number;
    /** 首次扫描进曲库的时间 */
    addedAt: number;
    /** iOS 删除用：Filesystem 目录标识 + 相对路径 */
    fsDirectory?: string;
    fsPath?: string;
}

function readLibrary(): ILocalMusicRecord[] {
    try {
        const raw = localStorage.getItem(LIB_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) {
            return [];
        }
        return arr.filter((it: any) => it && typeof it.localPath === "string");
    } catch {
        return [];
    }
}

function writeLibrary(list: ILocalMusicRecord[], bump = true) {
    try {
        localStorage.setItem(LIB_KEY, JSON.stringify(list));
    } catch {
        // ignore
    }
    if (bump) {
        bumpLocalMusicVersion();
    }
}

/** 曲库记录变化通知（匹配循环里会节流调用，避免列表频繁整体重置） */
function bumpLocalMusicVersion() {
    const store = getDefaultStore();
    store.set(localMusicVersionAtom, store.get(localMusicVersionAtom) + 1);
}

export function getLocalMusicList(): ILocalMusicRecord[] {
    return readLibrary();
}

export function getLocalMusicCount(): number {
    return readLibrary().length;
}

/** 曲库记录 → 播放器 / 列表用的音乐条目（artwork 转成 WebView 可加载的地址） */
export function toMusicItem(record: ILocalMusicRecord): IMusic.IMusicItem {
    const artwork = record.matchedArtwork || record.artwork;
    return {
        id: record.localPath,
        platform: "local",
        title: record.title,
        artist: record.artist,
        album: record.album,
        duration: record.duration,
        localPath: record.localPath,
        artwork: artwork ? localFileUrl(artwork) : "",
        // 匹配到的歌词随条目带给播放器（loadCurrentLyric 优先读 musicItem.lyric）
        ...(record.lyricPath ? { lyric: { lrc: localFileUrl(record.lyricPath) } } : {}),
    };
}

/** 按 localPath / id 反查曲库记录（播放器 / 历史里的条目 → 曲库记录） */
export function findLocalRecord(musicItem: {
    localPath?: string;
    id?: string;
}): ILocalMusicRecord | undefined {
    const key = String(musicItem.localPath ?? musicItem.id ?? "");
    if (!key) {
        return undefined;
    }
    return readLibrary().find((it) => it.localPath === key || it.id === key);
}

/* ---------- 扫描目录配置 ---------- */

export interface IScanDir {
    /** 目录标识：Android 为绝对路径；iOS 为「目录/相对路径」的展示串 */
    path: string;
    /** 列表里展示的名称（默认目录给友好名，自定义目录取最后一段） */
    label?: string;
    /** iOS Filesystem 目录标识（DOCUMENTS / DATA） */
    directory?: string;
    /** iOS 相对路径（"." 表示目录根） */
    rel?: string;
}

function readCustomDirs(): IScanDir[] | null {
    try {
        const raw = localStorage.getItem(DIRS_KEY);
        if (!raw) {
            return null;
        }
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length && arr.every((it: any) => typeof it?.path === "string")) {
            return arr as IScanDir[];
        }
    } catch {
        // ignore
    }
    return null;
}

function fileUriToPath(uri?: string): string {
    if (!uri) {
        return "";
    }
    try {
        let p = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
        p = p.replace(/\/\.$/, "").replace(/\/+$/, "");
        return p;
    } catch {
        return "";
    }
}

/** 默认扫描目录：系统下载目录 + 应用的音乐下载目录（跟随「设置 → 下载」的保存位置） */
async function defaultScanDirs(): Promise<IScanDir[]> {
    const platform = currentPlatform();
    const subfolder = getDownloadSubfolder();
    const target = getDownloadSaveTarget();
    const result: IScanDir[] = [];
    if (platform === "android") {
        try {
            const res = await callNativeMethod("LocalMusic", "getDefaultDirs");
            result.push({ path: res.downloads, label: "系统下载目录" });
        if (target === "documents") {
            result.push({
                path: `${res.documents}/${subfolder}`,
                label: `应用下载目录（文档 / ${subfolder}）`,
            });
        } else if (target === "external") {
            const extDir = getDownloadExternalDir();
            if (extDir) {
                result.push({
                    path: extDir,
                    label: `应用下载目录（${prettyAbsDir(extDir)}）`,
                });
            }
        } else if (target === "data") {
                result.push({
                    path: `${res.filesDir}/${subfolder}`,
                    label: `应用下载目录（应用私有 / ${subfolder}）`,
                });
            }
        } catch (e: any) {
            console.warn("[localMusic] 获取默认目录失败", e?.message ?? e);
        }
    } else if (platform === "ios") {
        try {
            const docs = fileUriToPath(
                (await callNativeMethod("Filesystem", "getUri", { path: ".", directory: "DOCUMENTS" }))?.uri,
            );
            const data = fileUriToPath(
                (await callNativeMethod("Filesystem", "getUri", { path: ".", directory: "DATA" }))?.uri,
            );
            result.push({ path: docs, label: "文档目录", directory: "DOCUMENTS", rel: "." });
            if (subfolder && target !== "system") {
                result.push({
                    path: `${docs}/${subfolder}`,
                    label: `文档目录 / ${subfolder}`,
                    directory: "DOCUMENTS",
                    rel: subfolder,
                });
                result.push({
                    path: `${data}/${subfolder}`,
                    label: `应用私有 / ${subfolder}`,
                    directory: "DATA",
                    rel: subfolder,
                });
            }
        } catch (e: any) {
            console.warn("[localMusic] 获取默认目录失败", e?.message ?? e);
        }
    }
    // 去重（下载子目录可能与系统目录重合等）
    const seen = new Set<string>();
    return result.filter((d) => d.path && !seen.has(d.path) && seen.add(d.path));
}

/** 当前生效的扫描目录（未自定义时按默认规则现算） */
export async function getEffectiveScanDirs(): Promise<IScanDir[]> {
    const custom = readCustomDirs();
    if (custom) {
        return custom;
    }
    return defaultScanDirs();
}

/** 是否处于「默认目录」模式 */
export function isScanDirsDefault(): boolean {
    return readCustomDirs() === null;
}

/** 自定义目录列表（添加 / 删除后调用；传空数组表示恢复默认） */
export function setCustomScanDirs(dirs: IScanDir[]) {
    if (dirs.length) {
        localStorage.setItem(DIRS_KEY, JSON.stringify(dirs));
    } else {
        localStorage.removeItem(DIRS_KEY);
    }
}

/** 是否跳过 60s 以内的音频 */
export function isSkipShortEnabled(): boolean {
    return localStorage.getItem(SKIP_KEY) !== "0";
}

export function setSkipShortEnabled(enabled: boolean) {
    localStorage.setItem(SKIP_KEY, enabled ? "1" : "0");
}

/* ---------- 扫描 ---------- */

export interface IScanResult {
    /** 本次扫到的曲目总数 */
    total: number;
    /** 相对上次曲库新增 */
    added: number;
    /** 上次有、这次没扫到（文件被移动 / 删除） */
    removed: number;
    /** 因「跳过短音频」被过滤的数量 */
    skippedShort: number;
    /** 无法读取的目录 */
    failedDirs: string[];
}

/** 扫描前的音频读取权限（Android；iOS 沙盒内无需授权，直接返回 true） */
export async function requestAudioPermission(): Promise<boolean> {
    if (currentPlatform() !== "android") {
        return true;
    }
    try {
        const res = await callNativeMethod("LocalMusic", "requestAudioPermission");
        return !!res?.granted;
    } catch (e: any) {
        console.warn("[localMusic] 权限请求失败", e?.message ?? e);
        return false;
    }
}

function rawToRecord(raw: any): ILocalMusicRecord | null {
    if (!raw || typeof raw.path !== "string" || !raw.path) {
        return null;
    }
    return {
        id: raw.path,
        platform: "local",
        title: String(raw.title || "未知标题"),
        artist: String(raw.artist || "未知歌手"),
        album: String(raw.album || ""),
        duration: Number(raw.duration) || 0,
        localPath: raw.path,
        size: Number(raw.size) || 0,
        format: String(raw.format || ""),
        bitrate: raw.bitrate ? Number(raw.bitrate) : undefined,
        sampleRate: raw.sampleRate ? Number(raw.sampleRate) : undefined,
        mtime: Number(raw.mtime) || 0,
        artwork: typeof raw.artwork === "string" && raw.artwork ? raw.artwork : undefined,
        addedAt: 0,
    };
}

function sortRecords(records: ILocalMusicRecord[]) {
    const collator = new Intl.Collator("zh-Hans-CN");
    records.sort((a, b) => {
        const byArtist = collator.compare(a.artist, b.artist);
        if (byArtist !== 0) {
            return byArtist;
        }
        return collator.compare(a.title, b.title) || a.localPath.localeCompare(b.localPath);
    });
    return records;
}

/** 执行一次扫描并整体替换曲库记录（已移出扫描目录的条目会随之消失） */
export async function scanLocalMusic(): Promise<IScanResult> {
    const platform = currentPlatform();
    if (platform === "web") {
        throw new Error("当前环境不支持本地音乐扫描，请在手机 App 中使用");
    }
    const dirs = await getEffectiveScanDirs();
    const skipShort = isSkipShortEnabled();
    const directories = dirs.map((d) => d.path);
    let rawItems: any[] = [];
    let skippedShort = 0;
    let failedDirs: string[] = [];

    if (platform === "android") {
        const res = await callNativeMethod("LocalMusic", "scan", { directories, skipShort });
        rawItems = Array.isArray(res?.items) ? res.items : [];
        skippedShort = Number(res?.skippedShort) || 0;
        failedDirs = Array.isArray(res?.failedDirs) ? res.failedDirs.map(String) : [];
    } else {
        const iosRes = await scanIOS(dirs, skipShort);
        rawItems = iosRes.items;
        skippedShort = iosRes.skippedShort;
        failedDirs = iosRes.failedDirs;
    }

    const prev = readLibrary();
    const prevKeys = new Set(prev.map((it) => it.id));
    const prevAddedAt = new Map(prev.map((it) => [it.id, it.addedAt]));
    // 匹配结果（歌词 / 封面文件仍在磁盘上）不因重新扫描丢失
    const prevMatch = new Map(
        prev.map((it) => [
            it.id,
            {
                lyricPath: it.lyricPath,
                matchedArtwork: it.matchedArtwork,
                matchedSource: it.matchedSource,
                matchedAt: it.matchedAt,
            },
        ]),
    );
    const records = sortRecords(
        rawItems
            .map(rawToRecord)
            .filter((it): it is ILocalMusicRecord => !!it)
            .map((it) => ({
                ...it,
                addedAt: prevAddedAt.get(it.id) || Date.now(),
                ...prevMatch.get(it.id),
            })),
    );
    const nextKeys = new Set(records.map((it) => it.id));
    writeLibrary(records);
    return {
        total: records.length,
        added: records.filter((it) => !prevKeys.has(it.id)).length,
        removed: prev.filter((it) => !nextKeys.has(it.id)).length,
        skippedShort,
        failedDirs,
    };
}

/* ---------- iOS：Filesystem 桥接扫描 ---------- */

interface IIosRawItem {
    path: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    size: number;
    mtime: number;
    format: string;
    fsDirectory: string;
    fsPath: string;
}

function joinRel(base: string, name: string): string {
    return base === "." || base === "" ? name : `${base}/${name}`;
}

/** 文件名拆「歌手 - 标题」（iOS 拿不到标签，这是最常见的手动命名习惯） */
function parseTitleFromFilename(name: string): { title: string; artist: string } {
    const base = name.replace(/\.[^.]+$/, "").trim();
    const at = base.indexOf(" - ");
    if (at > 0 && at < base.length - 3) {
        return { artist: base.slice(0, at).trim(), title: base.slice(at + 3).trim() };
    }
    return { artist: "未知歌手", title: base || name };
}

function parseMtime(value: any): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return Math.floor(parsed / 1000);
        }
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
            return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
        }
    }
    return 0;
}

async function scanIOS(
    dirs: IScanDir[],
    skipShort: boolean,
): Promise<{ items: IIosRawItem[]; skippedShort: number; failedDirs: string[] }> {
    const items: IIosRawItem[] = [];
    const failedDirs: string[] = [];
    const seen = new Set<string>();

    const walk = async (dir: IScanDir, rel: string, depth: number) => {
        if (depth > 6) {
            return;
        }
        let files: any[] = [];
        try {
            const res = await callNativeMethod("Filesystem", "readdir", {
                path: rel,
                directory: dir.directory,
            });
            files = Array.isArray(res?.files) ? res.files : [];
        } catch {
            if (depth === 0) {
                failedDirs.push(dir.path);
            }
            return;
        }
        for (const f of files) {
            const name = String(f?.name ?? "");
            if (!name || name.startsWith(".")) {
                continue;
            }
            const childRel = joinRel(rel, name);
            if (f.type === "directory") {
                await walk(dir, childRel, depth + 1);
            } else if (AUDIO_EXT_RE.test(name)) {
                let size = Number(f?.size) || 0;
                let mtime = parseMtime(f?.mtime);
                if (!size || !mtime) {
                    try {
                        const st = await callNativeMethod("Filesystem", "stat", {
                            path: childRel,
                            directory: dir.directory,
                        });
                        size = size || Number(st?.size) || 0;
                        mtime = mtime || parseMtime(st?.mtime);
                    } catch {
                        // ignore
                    }
                }
                const key = `${dir.directory}:${childRel}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                const parsed = parseTitleFromFilename(name);
                items.push({
                    path: `${dir.path}/${name}`,
                    title: parsed.title,
                    artist: parsed.artist,
                    album: "",
                    duration: 0,
                    size,
                    mtime,
                    format: name.split(".").pop()?.toLowerCase() ?? "",
                    fsDirectory: dir.directory!,
                    fsPath: childRel,
                });
            }
        }
    };

    for (const dir of dirs) {
        if (!dir.directory || dir.rel === undefined) {
            // iOS 只支持沙盒内的默认目录
            continue;
        }
        await walk(dir, dir.rel, 0);
    }

    // 时长探测：<audio> 读元数据，并发 3；短音频过滤在拿到时长后进行
    let skippedShort = 0;
    const probeQueue = items.filter((it) => it.fsPath);
    const concurrency = 3;
    let cursor = 0;
    const worker = async () => {
        while (cursor < probeQueue.length) {
            const item = probeQueue[cursor++];
            item.duration = await probeDurationIOS(item);
            if (skipShort && item.duration > 0 && item.duration < SHORT_AUDIO_SECONDS) {
                item.duration = -1; // 标记剔除
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, probeQueue.length) }, worker));
    const kept = items.filter((it) => {
        if (it.duration < 0) {
            skippedShort += 1;
            return false;
        }
        return true;
    });
    for (const it of kept) {
        it.duration = Math.round(it.duration * 10) / 10;
    }
    return { items: kept, skippedShort, failedDirs };
}

/** iOS 上用 <audio> 元数据探测时长（秒）；失败返回 0 */
async function probeDurationIOS(item: IIosRawItem, timeoutMs = 8000): Promise<number> {
    const absPath = await iosAbsPathFor(item.fsDirectory, item.fsPath);
    if (!absPath) {
        return 0;
    }
    return probeAudioDuration(localFileUrl(absPath), timeoutMs);
}

const iosAbsPathCache = new Map<string, string>();

async function iosAbsPathFor(directory: string, relPath: string): Promise<string> {
    if (!iosAbsPathCache.has(directory)) {
        try {
            const res = await callNativeMethod("Filesystem", "getUri", { path: ".", directory });
            iosAbsPathCache.set(directory, fileUriToPath(res?.uri));
        } catch {
            iosAbsPathCache.set(directory, "");
        }
    }
    const base = iosAbsPathCache.get(directory) ?? "";
    if (!base) {
        return "";
    }
    if (relPath === "." || relPath === "") {
        return base;
    }
    return joinRel(base === "" ? "" : base, relPath);
}

function probeAudioDuration(src: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve) => {
        if (!src) {
            resolve(0);
            return;
        }
        const audio = new Audio();
        let settled = false;
        const finish = (value: number) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            audio.removeAttribute("src");
            resolve(value);
        };
        const timer = setTimeout(() => finish(0), timeoutMs);
        audio.preload = "metadata";
        audio.onloadedmetadata = () => {
            finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
        };
        audio.onerror = () => finish(0);
        audio.src = src;
    });
}

/* ---------- 匹配歌词与封面 ---------- */

/**
 * 参考网易云「获取图词」的批量匹配：
 *  - 逐首用选定音源搜索候选，按标题 / 歌手 / 专辑 / 时长打分选最优；
 *  - getLyric 拿歌词、搜索结果的封面图下载落盘，写入曲库记录；
 *  - 任务可暂停 / 继续 / 停止，进度经 matchTaskAtom 驱动页面顶部进度条。
 * 歌词与封面都是小文件，存进应用目录（Android filesDir / iOS DATA），记录里只存路径。
 */

export interface IMatchOptions {
    /** 音源插件 hash；缺省用默认音源（排序后的第一个可搜索插件） */
    pluginHash?: string;
    matchLyric: boolean;
    matchCover: boolean;
    /** 只处理还没有歌词或封面的歌曲 */
    skipMatched: boolean;
}

export interface IMatchTaskState {
    status: "running" | "paused";
    total: number;
    done: number;
    matched: number;
    failed: number;
    /** 正在匹配的歌曲（歌手 - 标题） */
    current: string;
}

export const matchTaskAtom = atom<IMatchTaskState | null>(null);

interface IMatchRunner {
    paused: boolean;
    stopped: boolean;
}

/** 一次匹配任务的运行时上下文（队列与配置同时是持久化的数据来源） */
interface IMatchSession {
    runner: IMatchRunner;
    plugin: SerializedPlugin;
    options: IMatchOptions;
    /** 待处理曲目 id 队列，队首是正在处理的一首 */
    remaining: string[];
    lastSave: number;
}

let matchSession: IMatchSession | null = null;

export function isMatchRunning(): boolean {
    return matchSession !== null;
}

/* ----- 匹配任务持久化：应用退出（进程被杀）后，下次启动从这里续跑 ----- */

const MATCH_TASK_KEY = "localMusic.matchTask";

interface IPersistedMatchTask {
    options: IMatchOptions;
    pluginHash?: string;
    /** 还没处理完的曲目 id */
    remaining: string[];
    total: number;
    done: number;
    matched: number;
    failed: number;
    status: "running" | "paused";
    savedAt: number;
}

function readSavedMatchTask(): IPersistedMatchTask | null {
    try {
        const obj = JSON.parse(localStorage.getItem(MATCH_TASK_KEY) ?? "null");
        if (
            obj &&
            Array.isArray(obj.remaining) &&
            obj.remaining.every((id: any) => typeof id === "string") &&
            typeof obj.total === "number" &&
            typeof obj.options?.matchLyric === "boolean" &&
            typeof obj.options?.matchCover === "boolean"
        ) {
            return obj as IPersistedMatchTask;
        }
    } catch {
        // ignore
    }
    return null;
}

function writeSavedMatchTask(task: IPersistedMatchTask) {
    try {
        localStorage.setItem(MATCH_TASK_KEY, JSON.stringify(task));
    } catch {
        // ignore
    }
}

function clearSavedMatchTask() {
    try {
        localStorage.removeItem(MATCH_TASK_KEY);
    } catch {
        // ignore
    }
}

/** 把当前进度写进持久化（默认 1s 节流；任务启动 / 暂停 / 继续时强制写） */
function persistMatchProgress(session: IMatchSession, force = false) {
    const now = Date.now();
    if (!force && now - session.lastSave < 1000) {
        return;
    }
    const state = getDefaultStore().get(matchTaskAtom);
    if (!state) {
        return;
    }
    session.lastSave = now;
    writeSavedMatchTask({
        options: session.options,
        pluginHash: session.plugin.hash,
        remaining: session.remaining,
        total: state.total,
        done: state.done,
        matched: state.matched,
        failed: state.failed,
        status: session.runner.paused ? "paused" : "running",
        savedAt: now,
    });
}

export function pauseLocalMatch() {
    const session = matchSession;
    if (session) {
        session.runner.paused = true;
        getDefaultStore().set(matchTaskAtom, (prev) =>
            prev ? { ...prev, status: "paused", current: "" } : prev,
        );
        persistMatchProgress(session, true);
    }
}

export function resumeLocalMatch() {
    const session = matchSession;
    if (session) {
        session.runner.paused = false;
        getDefaultStore().set(matchTaskAtom, (prev) =>
            prev ? { ...prev, status: "running" } : prev,
        );
        persistMatchProgress(session, true);
    }
}

/** 停止任务：当前这首处理完后退出，结果由任务收尾时 toast 播报；持久化进度一并清除 */
export function stopLocalMatch() {
    const session = matchSession;
    if (session) {
        session.runner.stopped = true;
        session.runner.paused = false;
        clearSavedMatchTask();
    }
}

function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error("响应超时")), ms)),
    ]);
}

/** 批量匹配入口。整体跑在后台，页面经 matchTaskAtom 观察进度 */
export async function startLocalMatch(
    records: ILocalMusicRecord[],
    options: IMatchOptions,
): Promise<void> {
    if (matchSession) {
        throw new Error("已有匹配任务在进行中");
    }
    if (currentPlatform() === "web") {
        throw new Error("当前环境不支持匹配，请在手机 App 中使用");
    }
    if (!records.length) {
        throw new Error("本地音乐列表是空的");
    }
    if (!options.matchLyric && !options.matchCover) {
        throw new Error("请至少选择匹配歌词或封面");
    }
    const searchable = await getSortedSearchablePlugins();
    const plugin = options.pluginHash
        ? searchable.find((p) => p.hash === options.pluginHash) ?? searchable[0]
        : searchable[0];
    if (!plugin) {
        throw new Error("没有可用的音源插件，请先安装并启用");
    }

    const targets = options.skipMatched
        ? records.filter((it) => !(it.lyricPath || it.matchedArtwork))
        : [...records];
    if (!targets.length) {
        showToast("所选歌曲都已有歌词或封面，无需匹配");
        return;
    }
    // 等待音源初始化期间可能已恢复了上次的任务
    if (matchSession) {
        throw new Error("已有匹配任务在进行中");
    }

    const session: IMatchSession = {
        runner: { paused: false, stopped: false },
        plugin,
        options,
        remaining: targets.map((it) => it.id),
        lastSave: 0,
    };
    matchSession = session;
    getDefaultStore().set(matchTaskAtom, {
        status: "running",
        total: session.remaining.length,
        done: 0,
        matched: 0,
        failed: 0,
        current: "",
    });
    persistMatchProgress(session, true);
    await runMatchLoop(session);
}

/**
 * 启动时恢复上次未完成的匹配任务：应用退出（进程被杀）后 WebView 里的
 * 匹配循环随之消失，进度已持久化，这里读出来续跑。暂停状态下恢复为
 * 暂停，等用户在「本地音乐」页继续。
 */
export async function resumeSavedMatchTask(): Promise<void> {
    if (resumeInFlight || matchSession) {
        return;
    }
    const saved = readSavedMatchTask();
    if (!saved) {
        return;
    }
    resumeInFlight = true;
    try {
        const libById = new Map(readLibrary().map((it) => [it.id, it]));
        const remaining = saved.remaining.filter((id) => libById.has(id));
        if (!remaining.length) {
            // 剩余曲目已全部不在曲库里（重扫移除等），任务没有意义了
            clearSavedMatchTask();
            return;
        }
        const searchable = await getSortedSearchablePlugins();
        if (!searchable.length) {
            clearSavedMatchTask();
            showToast("没有可用音源插件，上次未完成的匹配任务已取消");
            return;
        }
        if (matchSession) {
            return;
        }
        const plugin = saved.pluginHash
            ? searchable.find((p) => p.hash === saved.pluginHash) ?? searchable[0]
            : searchable[0];
        const session: IMatchSession = {
            runner: { paused: saved.status === "paused", stopped: false },
            plugin,
            options: saved.options,
            remaining,
            lastSave: 0,
        };
        matchSession = session;
        getDefaultStore().set(matchTaskAtom, {
            status: session.runner.paused ? "paused" : "running",
            total: saved.done + remaining.length,
            done: saved.done,
            matched: saved.matched,
            failed: saved.failed,
            current: "",
        });
        // 暂停恢复也照常起循环：循环开头会在暂停态自旋等待
        void runMatchLoop(session).catch((e: any) =>
            console.warn("[localMusic] 恢复的匹配任务异常中断", e?.message ?? e),
        );
        showToast(
            session.runner.paused
                ? `已恢复上次暂停的匹配任务，还剩 ${remaining.length} 首，可在本地音乐页继续`
                : `继续上次的匹配任务，还剩 ${remaining.length} 首`,
            3600,
        );
    } finally {
        resumeInFlight = false;
    }
}

/** StrictMode 下 effect 会跑两遍，防止并发恢复出两个任务 */
let resumeInFlight = false;

async function runMatchLoop(session: IMatchSession): Promise<void> {
    const { runner, plugin, options, remaining } = session;
    const store = getDefaultStore();
    const byId = new Map(readLibrary().map((it) => [it.id, it]));
    try {
        // 匹配结果逐条落盘，但版本号节流自增（每 1.2s 最多一次），
        // 避免长列表页每首歌都整体重置渲染窗口
        let lastBump = 0;
        while (remaining.length) {
            while (runner.paused && !runner.stopped) {
                await sleep(160);
            }
            if (runner.stopped) {
                break;
            }
            const rec = byId.get(remaining[0]);
            if (!rec) {
                // 曲库重扫后该文件已不在，直接跳过
                remaining.shift();
                store.set(matchTaskAtom, (prev) =>
                    prev ? { ...prev, done: prev.done + 1 } : prev,
                );
                persistMatchProgress(session);
                continue;
            }
            store.set(matchTaskAtom, (prev) =>
                prev ? { ...prev, current: `${rec.artist} - ${rec.title}` } : prev,
            );
            try {
                const r = await matchOneRecord(rec, plugin, options);
                if (Date.now() - lastBump > 1200) {
                    bumpLocalMusicVersion();
                    lastBump = Date.now();
                }
                store.set(matchTaskAtom, (prev) =>
                    prev
                        ? {
                              ...prev,
                              done: prev.done + 1,
                              matched: prev.matched + (r.matched ? 1 : 0),
                              failed: prev.failed + (r.matched ? 0 : 1),
                          }
                        : prev,
                );
            } catch (e: any) {
                console.warn(`[localMusic] 匹配失败：${rec.title}`, e?.message ?? e);
                store.set(matchTaskAtom, (prev) =>
                    prev ? { ...prev, done: prev.done + 1, failed: prev.failed + 1 } : prev,
                );
            }
            // 处理完（含失败）才出队：中途被杀时这首下次会重跑
            remaining.shift();
            persistMatchProgress(session);
        }
    } finally {
        const state = store.get(matchTaskAtom);
        const isCurrent = matchSession === session;
        if (isCurrent) {
            matchSession = null;
        }
        store.set(matchTaskAtom, null);
        // 跑完 / 用户停止才清持久化；异常中断时保留，下次启动续跑
        if (isCurrent && !runner.stopped && !remaining.length) {
            clearSavedMatchTask();
        }
        // 收尾补一次刷新（节流期间落盘的最后几条也要上屏）
        bumpLocalMusicVersion();
        if (state) {
            showToast(
                runner.stopped
                    ? `已停止：处理了 ${state.done}/${state.total} 首，成功匹配 ${state.matched} 首`
                    : `匹配完成：成功 ${state.matched} 首${
                          state.failed ? `，${state.failed} 首未能匹配` : ""
                      }`,
                4200,
            );
        }
    }
}

/* ----- 候选搜索与打分 ----- */

function searchCandidates(
    plugin: SerializedPlugin,
    kw: string,
): Promise<IMusic.IMusicItem[]> {
    return withTimeout(
        pluginCall<IPlugin.ISearchResult<"music">>(plugin.hash, "search", kw, 1, "music"),
        16000,
    )
        .then((res) =>
            Array.isArray(res?.data) ? (res.data.filter((it) => it?.title) as IMusic.IMusicItem[]) : [],
        )
        .catch(() => []);
}

/** 归一化：去括号备注（Live / Remix…）、去空白标点，只留字母数字 */
function normalizeMeta(s: string): string {
    return (s || "")
        .toLowerCase()
        .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function editSimilarity(a: string, b: string): number {
    if (!a || !b) {
        return 0;
    }
    if (a === b) {
        return 1;
    }
    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
}

/** 歌手相似度：多歌手（/ 、& feat）拆词后任一命中即算匹配 */
function artistSimilarity(a: string, b: string): number {
    const na = normalizeMeta(a);
    const nb = normalizeMeta(b);
    if (!na || !nb) {
        // 一方缺歌手名时给中性分，不打死也不加权
        return 0.5;
    }
    if (na === nb || na.includes(nb) || nb.includes(na)) {
        return 1;
    }
    const tokens = (s: string) => s.split(/[/\s、,，&＆]|feat\.?|ft\.?/i).filter(Boolean);
    const ta = tokens(a.toLowerCase());
    const tb = tokens(b.toLowerCase());
    if (ta.some((x) => tb.some((y) => normalizeMeta(x) && normalizeMeta(x) === normalizeMeta(y)))) {
        return 0.95;
    }
    return 0;
}

/** 插件返回的时长单位不统一（秒 / 毫秒），粗略换算后再比较 */
function candidateDuration(item: IMusic.IMusicItem): number {
    const d = Number(item.duration) || 0;
    // 正常歌曲不会超过 10000 秒；毫秒值至少也是几十万
    return d >= 10000 ? Math.round(d / 1000) : Math.round(d);
}

const MATCH_SCORE_THRESHOLD = 2;

function pickBestCandidate(
    rec: ILocalMusicRecord,
    candidates: IMusic.IMusicItem[],
): IMusic.IMusicItem | null {
    const nTitle = normalizeMeta(rec.title);
    const nArtist = rec.artist && rec.artist !== "未知歌手" ? rec.artist : "";
    const nAlbum = normalizeMeta(rec.album);
    let best: IMusic.IMusicItem | null = null;
    let bestScore = 0;
    for (const cand of candidates) {
        const titleSim = editSimilarity(nTitle, normalizeMeta(cand.title));
        if (titleSim < 0.55) {
            continue;
        }
        const artistSim = artistSimilarity(nArtist, cand.artist);
        let score = titleSim * 2 + artistSim * 1.1;
        if (nAlbum && normalizeMeta(cand.album) === nAlbum) {
            score += 0.4;
        }
        const cd = candidateDuration(cand);
        if (rec.duration > 0 && cd > 0) {
            const diff = Math.abs(rec.duration - cd);
            if (diff <= 4) {
                score += 0.5;
            } else if (diff > 20) {
                score -= 0.6;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = cand;
        }
    }
    return bestScore >= MATCH_SCORE_THRESHOLD ? best : null;
}

/* ----- 歌词 / 封面获取与落盘 ----- */

function strHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/** 匹配文件的稳定文件名键（同一首歌重复匹配复用同名文件） */
function matchFileKey(rec: ILocalMusicRecord): string {
    return strHash(rec.localPath);
}

async function removeAndroidFile(absPath?: string) {
    if (!absPath) {
        return;
    }
    try {
        await callNativeMethod("Storage", "deleteFile", { path: absPath });
    } catch {
        // 旧文件删不掉不影响新文件写入
    }
}

async function removeIosFile(absPath?: string) {
    if (!absPath) {
        return;
    }
    const base = await iosAbsPathFor("DATA", ".");
    if (base && absPath.startsWith(`${base}/`)) {
        try {
            await callNativeMethod("Filesystem", "deleteFile", {
                path: absPath.slice(base.length + 1),
                directory: "DATA",
            });
        } catch {
            // ignore
        }
    }
}

async function saveLyricFile(rec: ILocalMusicRecord, rawLrc: string): Promise<string> {
    const platform = currentPlatform();
    try {
        if (platform === "android") {
            const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
            const abs = `${dirs.filesDir}/match_meta/lyric_${matchFileKey(rec)}.lrc`;
            await writeAndroidFile(abs, new Blob([rawLrc], { type: "text/plain" }));
            if (rec.lyricPath && rec.lyricPath !== abs) {
                await removeAndroidFile(rec.lyricPath);
            }
            return abs;
        }
        const rel = `match_meta/lyric_${matchFileKey(rec)}.lrc`;
        await writeIosFile("DATA", rel, new Blob([rawLrc], { type: "text/plain" }));
        const base = await iosAbsPathFor("DATA", ".");
        if (rec.lyricPath && rec.lyricPath !== `${base}/${rel}`) {
            await removeIosFile(rec.lyricPath);
        }
        return base ? `${base}/${rel}` : "";
    } catch (e: any) {
        console.warn("[localMusic] 歌词保存失败", e?.message ?? e);
        return "";
    }
}

async function saveCoverFile(rec: ILocalMusicRecord, url: string): Promise<string> {
    const platform = currentPlatform();
    try {
        let blob: Blob;
        if (url.startsWith("data:")) {
            blob = await (await fetch(url)).blob();
        } else {
            const resp = await withTimeout(fetch(url), 20000);
            if (!resp.ok) {
                return "";
            }
            blob = await resp.blob();
        }
        // 太小多半是占位图，太大不必要地占空间
        if (blob.size < 1024 || blob.size > 10 * 1024 * 1024) {
            return "";
        }
        if (platform === "android") {
            const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
            const abs = `${dirs.filesDir}/match_meta/cover_${matchFileKey(rec)}.img`;
            await writeAndroidFile(abs, blob);
            if (rec.matchedArtwork && rec.matchedArtwork !== abs) {
                await removeAndroidFile(rec.matchedArtwork);
            }
            return abs;
        }
        const rel = `match_meta/cover_${matchFileKey(rec)}.img`;
        await writeIosFile("DATA", rel, blob);
        const base = await iosAbsPathFor("DATA", ".");
        if (rec.matchedArtwork && rec.matchedArtwork !== `${base}/${rel}`) {
            await removeIosFile(rec.matchedArtwork);
        }
        return base ? `${base}/${rel}` : "";
    } catch (e: any) {
        console.warn("[localMusic] 封面保存失败", e?.message ?? e);
        return "";
    }
}

/** 拉取歌词原文；只收带时间轴的 LRC（纯文本在播放页无法滚动展示） */
async function fetchLyricRaw(
    plugin: SerializedPlugin,
    item: IMusic.IMusicItem,
): Promise<string> {
    try {
        const src = await withTimeout<ILyric.ILyricSource>(
            pluginCall(plugin.hash, "getLyric", item),
            16000,
        );
        let raw = "";
        if (src?.rawLrc) {
            raw = String(src.rawLrc);
        } else if (src?.lrc) {
            if (/^https?:/i.test(src.lrc)) {
                const resp = await withTimeout(fetch(src.lrc), 16000);
                raw = resp.ok ? await resp.text() : "";
            } else {
                raw = String(src.lrc);
            }
        }
        return raw.includes("[") && /\[\d+:\d+/.test(raw) ? raw : "";
    } catch {
        return "";
    }
}

/** 候选封面地址：搜索结果没有时再问一次 getMusicInfo */
async function resolveCoverUrl(
    plugin: SerializedPlugin,
    item: IMusic.IMusicItem,
): Promise<string> {
    if (typeof item.artwork === "string" && item.artwork) {
        return item.artwork;
    }
    if (plugin.supportedMethods.includes("getMusicInfo")) {
        try {
            const info = await withTimeout<any>(
                pluginCall(plugin.hash, "getMusicInfo", item),
                12000,
            );
            if (typeof info?.artwork === "string") {
                return info.artwork;
            }
        } catch {
            // ignore
        }
    }
    return "";
}

function applyRecordUpdate(id: string, updates: Partial<ILocalMusicRecord>) {
    const list = readLibrary();
    const idx = list.findIndex((it) => it.id === id);
    if (idx < 0) {
        return;
    }
    list[idx] = { ...list[idx], ...updates };
    // 版本号由匹配循环节流自增，这里只落盘
    writeLibrary(list, false);
}

async function matchOneRecord(
    rec: ILocalMusicRecord,
    plugin: SerializedPlugin,
    options: IMatchOptions,
): Promise<{ matched: boolean; gotLyric: boolean; gotCover: boolean }> {
    const hasArtist = rec.artist && rec.artist !== "未知歌手";
    const kw = hasArtist ? `${rec.title} ${rec.artist}` : rec.title;
    let candidates = await searchCandidates(plugin, kw);
    if (!candidates.length && kw !== rec.title) {
        candidates = await searchCandidates(plugin, rec.title);
    }
    if (!candidates.length) {
        return { matched: false, gotLyric: false, gotCover: false };
    }
    const best = pickBestCandidate(rec, candidates);
    if (!best) {
        return { matched: false, gotLyric: false, gotCover: false };
    }

    const updates: Partial<ILocalMusicRecord> = {};
    if (options.matchLyric) {
        const raw = await fetchLyricRaw(plugin, best);
        if (raw) {
            const path = await saveLyricFile(rec, raw);
            if (path) {
                updates.lyricPath = path;
            }
        }
    }
    if (options.matchCover) {
        const coverUrl = await resolveCoverUrl(plugin, best);
        if (coverUrl) {
            const path = await saveCoverFile(rec, coverUrl);
            if (path) {
                updates.matchedArtwork = path;
            }
        }
    }
    if (!updates.lyricPath && !updates.matchedArtwork) {
        return { matched: false, gotLyric: false, gotCover: false };
    }
    updates.matchedSource = plugin.name;
    updates.matchedAt = Math.floor(Date.now() / 1000);
    applyRecordUpdate(rec.id, updates);
    return {
        matched: true,
        gotLyric: !!updates.lyricPath,
        gotCover: !!updates.matchedArtwork,
    };
}

/**
 * 播放详情页「获取封面歌词」：只匹配当前播放的这一首，缺什么补什么
 * （已有歌词就不再拉歌词；扫描提取的内嵌封面还在就不换封面）。
 * 成功后把新封面 / 歌词同步进播放器的当前曲目与队列条目（不打断播放），
 * 并 bump 曲库版本号驱动本地音乐列表刷新。
 */
export async function matchSingleLocalMusic(
    musicItem: IMusic.IMusicItem,
): Promise<{ matched: boolean; gotLyric: boolean; gotCover: boolean }> {
    if (currentPlatform() === "web") {
        throw new Error("当前环境不支持匹配，请在手机 App 中使用");
    }
    const rec = findLocalRecord(musicItem);
    if (!rec) {
        throw new Error("本地曲库里没有这首歌的记录");
    }
    const options: IMatchOptions = {
        matchLyric: !rec.lyricPath,
        matchCover: !(rec.matchedArtwork || rec.artwork),
        skipMatched: false,
    };
    if (!options.matchLyric && !options.matchCover) {
        return { matched: false, gotLyric: false, gotCover: false };
    }
    const searchable = await getSortedSearchablePlugins();
    if (!searchable.length) {
        throw new Error("没有可用的音源插件，请先安装并启用");
    }
    // 单首匹配没有选源面板：跟随用户设置的默认音源，没设置就用排序后的第一个
    const defaultHash = localStorage.getItem("defaultPluginHash") || "";
    const plugin = searchable.find((p) => p.hash === defaultHash) ?? searchable[0];
    const r = await matchOneRecord(rec, plugin, options);
    if (r.matched) {
        const fresh = readLibrary().find((it) => it.id === rec.id);
        if (fresh) {
            TrackPlayerSingleton.updateMusicItemMeta(toMusicItem(fresh));
        }
        bumpLocalMusicVersion();
    }
    return r;
}

/* ----- 旧条目的歌词现查（历史 / 歌单里存的本地条目可能没有随匹配更新） ----- */

async function readLyricFor(musicItem: IMusic.IMusicItem): Promise<string> {
    if (!isNative()) {
        return "";
    }
    const rec = findLocalRecord(musicItem);
    if (!rec?.lyricPath) {
        return "";
    }
    const resp = await fetch(localFileUrl(rec.lyricPath));
    return resp.ok ? await resp.text() : "";
}

setLocalLyricResolver(readLyricFor);

/* ---------- 删除 ---------- */

export interface IRemoveLocalResult {
    removed: number;
    fileDeleted: number;
    fileFailed: number;
}

/**
 * 从本地曲库移除记录；deleteFiles 为 true 时同时删除音频文件。
 * 文件删除尽力而为：单文件失败（系统弹窗被取消 / 无权限）不阻断其余文件。
 */
export async function removeLocalMusic(
    items: IMusic.IMusicItem[],
    deleteFiles: boolean,
): Promise<IRemoveLocalResult> {
    const keys = new Set(items.map((it) => `${it.platform}-${it.id}`));
    const list = readLibrary();
    const targets = list.filter((it) => keys.has(`${it.platform}-${it.id}`));
    let fileDeleted = 0;
    let fileFailed = 0;
    if (deleteFiles) {
        const platform = currentPlatform();
        for (const record of targets) {
            try {
                if (platform === "android") {
                    const res = await callNativeMethod("LocalMusic", "deleteFile", {
                        path: record.localPath,
                    });
                    if (!res?.deleted) {
                        throw new Error(res?.reason || "删除失败");
                    }
                } else if (platform === "ios" && record.fsDirectory) {
                    await callNativeMethod("Filesystem", "deleteFile", {
                        path: record.fsPath ?? "",
                        directory: record.fsDirectory,
                    });
                } else {
                    throw new Error("当前环境不支持删除文件");
                }
                fileDeleted += 1;
            } catch (e: any) {
                console.warn(`[localMusic] 删除文件失败：${record.localPath}`, e?.message ?? e);
                fileFailed += 1;
            }
        }
    }
    if (targets.length) {
        writeLibrary(list.filter((it) => !keys.has(`${it.platform}-${it.id}`)));
    }
    return { removed: targets.length, fileDeleted, fileFailed };
}

/* ---------- 展示辅助 ---------- */

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "未知";
    }
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
    }
    if (bytes >= 1024 ** 2) {
        return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
    }
    if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)}KB`;
    }
    return `${bytes}B`;
}

/** 目录列表里展示的名称：默认目录用友好名，自定义目录取最后一段 */
export function scanDirLabel(dir: IScanDir): string {
    if (dir.label) {
        return dir.label;
    }
    const parts = dir.path.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? dir.path;
}
