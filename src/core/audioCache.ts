import { atom, getDefaultStore } from "jotai";
import { callNativeMethod, nativePlatform, localFileUrl, writeAndroidFile, writeIosFile } from "./native";
import { getProxyBase } from "./net";
import { b64urlEncode } from "./ipc";

/**
 * 播放缓存：听过的歌在播放时后台整首存进应用缓存目录，再次播放直接读本地，
 * 省流量、秒开、断网也能重听最近播过的歌。
 *
 * 存储通道按平台分流：
 *  - Android：Storage 插件写入 cacheDir/audio-cache（绝对路径，应用私有目录免权限）；
 *  - iOS：Filesystem 插件写入 CACHE 沙盒目录；
 *  - 浏览器：Cache API（mf-audio-v1），播放时转成 blob URL。
 *
 * 索引（大小 / 最近使用时间 / 文件路径）落在 localStorage，是缓存内容的事实来源：
 *  - 上限（设置页可选 2G/5G/10G/不限）超限时按 LRU 淘汰，正在播放的那首受保护；
 *  - 命中时校验文件仍在（系统清缓存等导致的漂移会把条目摘掉，回退在线播放）。
 *
 * 缓存下载是后台串行任务：新一首歌入队会中止在途下载（起播优先），全程静默，
 * 失败只打日志不影响播放。下载与「歌曲下载」互不相干：下载的是用户留存副本，
 * 这里只是可随时重建的播放缓存。
 */

export const AUDIO_CACHE_LIMIT_KEY = "audioCache.limitMB";

/** 缓存上限选项（MB；0 = 不限），默认 2G */
export const AUDIO_CACHE_LIMIT_OPTIONS = [
    { value: "2048", label: "2 GB" },
    { value: "5120", label: "5 GB" },
    { value: "10240", label: "10 GB" },
    { value: "0", label: "不限" },
];

const DEFAULT_LIMIT_MB = 2048;

/** 浏览器 Cache API 的仓库名 */
const WEB_CACHE_NAME = "mf-audio-v1";

/**
 * Cache API 条目键：cache.put/match 只接受 http(s) 请求，缓存键（platform-id@quality）
 * 统一折进合法 URL 的路径里。
 */
function webCacheKey(key: string): string {
    return `https://audio.cache.local/${encodeURIComponent(key)}`;
}

/** 索引的 localStorage 键 */
const INDEX_KEY = "audioCache.index";

export interface IAudioCacheEntry {
    /** 文件字节数 */
    size: number;
    /** 最近一次使用（命中 / 写入）时间戳，LRU 依据 */
    lastUsed: number;
    /** Android：绝对路径；iOS：CACHE 目录内文件名；浏览器无 */
    path?: string;
    /** 展示用元数据 */
    title?: string;
    artist?: string;
    quality?: string;
}

type AudioCacheIndex = Record<string, IAudioCacheEntry>;

/** 缓存内容变化（写入 / 淘汰 / 清理）后自增，设置页据此刷新占用展示 */
export const audioCacheVersionAtom = atom(0);

/* ---------- 索引读写 ---------- */

function readIndex(): AudioCacheIndex {
    try {
        const raw = localStorage.getItem(INDEX_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as AudioCacheIndex;
        }
    } catch {
        // ignore
    }
    return {};
}

function writeIndex(index: AudioCacheIndex, bump = true) {
    try {
        localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
        // ignore
    }
    if (bump) {
        const store = getDefaultStore();
        store.set(audioCacheVersionAtom, store.get(audioCacheVersionAtom) + 1);
    }
}

/* ---------- 上限配置 ---------- */

export function getAudioCacheLimitMB(): number {
    const raw = localStorage.getItem(AUDIO_CACHE_LIMIT_KEY);
    const n = Number(raw);
    if (raw === null || !Number.isFinite(n) || n < 0) {
        return DEFAULT_LIMIT_MB;
    }
    return Math.round(n);
}

export function setAudioCacheLimitMB(mb: number) {
    localStorage.setItem(AUDIO_CACHE_LIMIT_KEY, String(Math.max(0, Math.round(mb))));
}

export function getAudioCacheLimitLabel(mb = getAudioCacheLimitMB()): string {
    return AUDIO_CACHE_LIMIT_OPTIONS.find((o) => Number(o.value) === mb)?.label ?? `${mb}MB`;
}

/* ---------- 缓存键 ---------- */

export function cacheKeyOf(musicItem: IMusic.IMusicItem, quality: string): string {
    return `${musicItem.platform}-${musicItem.id}@${quality}`;
}

/* ---------- 大小格式化（设置页展示） ---------- */

export function formatAudioCacheSize(bytes: number): string {
    if (!bytes || bytes <= 0) {
        return "0KB";
    }
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 当前缓存占用（索引统计；条目是写入时记录的实际字节数） */
export function getAudioCacheStats(): { count: number; size: number } {
    const index = readIndex();
    let size = 0;
    for (const entry of Object.values(index)) {
        size += entry.size || 0;
    }
    return { count: Object.keys(index).length, size };
}

/* ---------- 文件名 ---------- */

function safeKey(key: string): string {
    return key.replace(/[^\w.-]/g, "_");
}

/** 扩展名：先看直链路径，再猜 content-type，兜底 mp3（缓存文件名无关展示，仅给播放器辨识用） */
function inferExt(url: string, contentType: string): string {
    const m = url.split(/[?#]/)[0].match(/\.(mp3|flac|m4a|aac|wav|ogg|opus)$/i);
    if (m) {
        return m[1].toLowerCase();
    }
    const table: Record<string, string> = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/flac": "flac",
        "audio/x-flac": "flac",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/aac": "aac",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
    };
    return table[(contentType || "").split(";")[0].trim().toLowerCase()] ?? "mp3";
}

/* ---------- 删除 ---------- */

/** 删除单个条目对应的文件 / 网络缓存，尽力而为 */
async function removeEntryFile(key: string, entry: IAudioCacheEntry) {
    try {
        if (nativePlatform() === "android" && entry.path) {
            await callNativeMethod("Storage", "deleteFile", { path: entry.path });
        } else if (nativePlatform() === "ios" && entry.path) {
            await callNativeMethod("Filesystem", "deleteFile", {
                path: entry.path,
                directory: "CACHE",
            });
        } else if (!nativePlatform()) {
            const cache = await caches.open(WEB_CACHE_NAME);
            await cache.delete(webCacheKey(key));
        }
    } catch (e) {
        console.warn(`[audioCache] 删除缓存文件失败：${key}`, e);
    }
}

function dropEntry(index: AudioCacheIndex, key: string, bump = true) {
    delete index[key];
    writeIndex(index, bump);
}

/* ---------- 试听片段防御 ---------- */

/**
 * 缓存条目是否为「试听片段」：按最低可信码率（96kbps ≈ 12KB/s）估算，
 * 实际字节数撑不起歌曲元数据时长时，几乎只能是音源给的 30s 试听直链。
 * 这类片段一旦入缓存，之后每次播放都会命中（缓存优先于在线解析），
 * 表现为「这首歌永远只能听 30 秒」——写入前拦截，命中时自愈清除。
 */
function looksLikeTrialFragment(sizeBytes: number, durationSec?: number): boolean {
    if (!sizeBytes || !durationSec || durationSec < 60) {
        return false;
    }
    return sizeBytes < durationSec * 12 * 1024;
}

/* ---------- 查找（播放用） ---------- */

/** 最近一次命中 / 写入的缓存键：LRU 淘汰时不删它（通常是正在播放的这首） */
let protectedKey = "";

/**
 * 查缓存的可播放地址：命中返回本地可用的 URL（原生文件地址 / 浏览器 blob URL），
 * 未命中或文件已漂移返回 null。命中会顺带刷新 LRU 时间。
 */
export async function lookupCachedSrc(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey | null,
): Promise<string | null> {
    if (musicItem.localPath) {
        return null;
    }
    const key = cacheKeyOf(musicItem, quality ?? "auto");
    const index = readIndex();
    const entry = index[key];
    if (!entry) {
        return null;
    }
    // 旧版本可能已把试听片段写入缓存：命中前校验大小与时长，不符就摘掉回在线播放
    if (looksLikeTrialFragment(entry.size, musicItem.duration)) {
        dropEntry(index, key);
        removeEntryFile(key, entry);
        return null;
    }
    try {
        const platform = nativePlatform();
        if (platform === "android") {
            // statFile 缺方法（旧 APK）时 resolve 不到结果，按存在处理，播放失败有兜底
            const stat = await callNativeMethod("Storage", "statFile", { path: entry.path }).catch(
                () => null,
            );
            if (stat && stat.exists === false) {
                dropEntry(index, key);
                return null;
            }
            protectedKey = key;
            touch(index, key);
            return localFileUrl(entry.path!);
        }
        if (platform === "ios") {
            // getUri 对不存在的文件会 reject，顺带充当存在性校验
            const uri = await callNativeMethod("Filesystem", "getUri", {
                path: entry.path,
                directory: "CACHE",
            });
            const src = String(uri?.uri ?? "");
            if (!src) {
                return null;
            }
            protectedKey = key;
            touch(index, key);
            return src;
        }
        const src = await webLookup(key);
        if (!src) {
            dropEntry(index, key);
            return null;
        }
        protectedKey = key;
        touch(index, key);
        return src;
    } catch (e) {
        console.warn(`[audioCache] 读取缓存失败：${key}`, e);
        return null;
    }
}

function touch(index: AudioCacheIndex, key: string) {
    const entry = index[key];
    if (entry) {
        entry.lastUsed = Date.now();
        writeIndex(index, false);
    }
}

/* ---------- 浏览器通道（Cache API + blob URL） ---------- */

/**
 * blob URL 不主动 revoke：吊销仍被 <audio> 使用的地址会让回退 seek 失败；
 * 每次命中只新增一个指向已缓存数据的 URL，整个会话数量有限，页面关闭统一释放。
 */
async function webLookup(key: string): Promise<string | null> {
    if (typeof caches === "undefined") {
        return null;
    }
    const cache = await caches.open(WEB_CACHE_NAME);
    const match = await cache.match(webCacheKey(key));
    if (!match) {
        return null;
    }
    const blob = await match.blob();
    return URL.createObjectURL(blob);
}

/* ---------- 后台写入 ---------- */

interface IStoreRequest {
    key: string;
    musicItem: IMusic.IMusicItem;
    quality: string;
    source?: IPlugin.IMediaSourceResult;
}

/** 排队中的键（去重） */
const pendingKeys = new Set<string>();
/** 串行任务链：新请求会中止在途下载，让最新的歌优先写完 */
let storeChain: Promise<void> = Promise.resolve();
let activeAbort: AbortController | null = null;

/**
 * 请求后台缓存一首歌（播放 / 切音质解析出直链后调用，fire-and-forget）。
 * 已缓存、已在队列、本地歌曲、浏览器无 Cache API 时跳过；
 * 有在途下载时中止它——刚点开的歌优先，被中止的那首下次播放再试。
 */
export function requestAudioCacheStore(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey | null,
    source?: IPlugin.IMediaSourceResult,
) {
    if (musicItem.localPath || !musicItem.id || !musicItem.platform) {
        return;
    }
    if (nativePlatform() === null && typeof caches === "undefined") {
        return;
    }
    if (!source?.url) {
        return;
    }
    const q = quality ?? "auto";
    const key = cacheKeyOf(musicItem, q);
    if (readIndex()[key] || pendingKeys.has(key)) {
        return;
    }
    pendingKeys.add(key);
    protectedKey = key;
    activeAbort?.abort();
    const request: IStoreRequest = { key, musicItem, quality: q, source };
    storeChain = storeChain
        .then(() => doStore(request))
        .catch((e) => console.warn("[audioCache] 缓存任务异常", e));
}

async function doStore(request: IStoreRequest) {
    const { key, musicItem, quality, source } = request;
    const abort = new AbortController();
    activeAbort = abort;
    try {
        const headers: Record<string, string> = { ...(source?.headers ?? {}) };
        if (
            source?.userAgent &&
            !Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")
        ) {
            headers["User-Agent"] = source.userAgent;
        }
        const blob = await fetchAudioBlob(source!.url!, headers, abort.signal);
        if (abort.signal.aborted) {
            return;
        }
        // 试听片段不入缓存：缓存优先于在线解析，一旦写入就永远是 30 秒
        if (looksLikeTrialFragment(blob.size, musicItem.duration)) {
            console.warn(
                `[audioCache] 「${musicItem.title}」解析到试听片段（${formatAudioCacheSize(
                    blob.size,
                )}/${musicItem.duration}s），跳过缓存`,
            );
            return;
        }
        const stored = await writeToCache(key, blob, source!.url!, blob.type || "");
        if (!stored) {
            return;
        }
        const index = readIndex();
        index[key] = {
            size: blob.size,
            lastUsed: Date.now(),
            ...stored,
            title: musicItem.title,
            artist: musicItem.artist,
            quality,
        };
        writeIndex(index);
        await enforceAudioCacheLimit();
    } catch (e: any) {
        if (!abort.signal.aborted) {
            console.warn(`[audioCache] 缓存「${musicItem.title}」失败：`, e?.message ?? e);
        }
    } finally {
        if (activeAbort === abort) {
            activeAbort = null;
        }
        pendingKeys.delete(key);
    }
}

/**
 * 拉取音频整包：直连优先（原生端 CapacitorHttp 接管 fetch，可带自定义请求头），
 * 带请求头的直链在浏览器被 CORS 拦截时走伴生代理 /media 转发。
 */
async function fetchAudioBlob(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
): Promise<Blob> {
    const attempt = async (target: string, withHeaders: boolean): Promise<Blob> => {
        const resp = await fetch(target, {
            ...(withHeaders && Object.keys(headers).length ? { headers } : undefined),
            signal,
        });
        if (!resp.ok) {
            throw new Error(`请求失败 (${resp.status})`);
        }
        const blob = await resp.blob();
        if (!blob.size) {
            throw new Error("音频内容为空");
        }
        return blob;
    };
    try {
        return await attempt(url, true);
    } catch (e) {
        if (signal.aborted) {
            throw e;
        }
        const proxyBase = getProxyBase();
        if (!proxyBase) {
            throw e;
        }
        return attempt(
            `${proxyBase}/media?u=${b64urlEncode(url)}&h=${b64urlEncode(JSON.stringify(headers))}`,
            false,
        );
    }
}

/** 写入缓存目录 / Cache API，返回要进索引的位置信息；失败返回 null */
async function writeToCache(
    key: string,
    blob: Blob,
    rawUrl: string,
    contentType: string,
): Promise<{ path?: string } | null> {
    const platform = nativePlatform();
    if (platform === "android") {
        const dir = await androidCacheDir();
        const path = `${dir}/${safeKey(key)}.${inferExt(rawUrl, contentType)}`;
        await writeAndroidFile(path, blob);
        return { path };
    }
    if (platform === "ios") {
        const path = `${safeKey(key)}.${inferExt(rawUrl, contentType)}`;
        await writeIosFile("CACHE", path, blob);
        return { path };
    }
    if (typeof caches !== "undefined") {
        const cache = await caches.open(WEB_CACHE_NAME);
        await cache.put(webCacheKey(key), new Response(blob));
        return {};
    }
    return null;
}

/** Android 缓存目录：cacheDir/audio-cache（旧 APK 无 cacheDir 字段时退回 filesDir/cache） */
let androidCacheDirCached = "";
async function androidCacheDir(): Promise<string> {
    if (androidCacheDirCached) {
        return androidCacheDirCached;
    }
    const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
    const cacheDir = String(dirs?.cacheDir ?? "");
    const filesDir = String(dirs?.filesDir ?? "");
    if (!cacheDir && !filesDir) {
        throw new Error("无法确定缓存目录");
    }
    androidCacheDirCached = `${cacheDir || `${filesDir}/cache`}/audio-cache`;
    return androidCacheDirCached;
}

/* ---------- 淘汰 / 清理 ---------- */

/**
 * 按上限执行 LRU 淘汰（索引驱动，不动正受保护的最近播放键）。
 * 设置页改上限、每次写入成功后都会调用。
 */
export async function enforceAudioCacheLimit(): Promise<void> {
    const limitMB = getAudioCacheLimitMB();
    if (limitMB <= 0) {
        return;
    }
    const limitBytes = limitMB * 1024 * 1024;
    const index = readIndex();
    let total = 0;
    for (const entry of Object.values(index)) {
        total += entry.size || 0;
    }
    if (total <= limitBytes) {
        return;
    }
    const ordered = Object.entries(index)
        .filter(([key]) => key !== protectedKey)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key, entry] of ordered) {
        if (total <= limitBytes) {
            break;
        }
        await removeEntryFile(key, entry);
        delete index[key];
        total -= entry.size || 0;
    }
    writeIndex(index);
}

/** 一键清空：删除全部缓存文件并重置索引，返回释放的字节数 */
export async function clearAudioCache(): Promise<{ removed: number; sizeFreed: number }> {
    activeAbort?.abort();
    const index = readIndex();
    const entries = Object.entries(index);
    let sizeFreed = 0;
    for (const [key, entry] of entries) {
        sizeFreed += entry.size || 0;
        await removeEntryFile(key, entry);
    }
    if (typeof caches !== "undefined" && nativePlatform() === null) {
        // 浏览器通道整体删库，漏网的旧条目一并清掉
        try {
            await caches.delete(WEB_CACHE_NAME);
        } catch {
            // ignore
        }
    }
    try {
        localStorage.removeItem(INDEX_KEY);
    } catch {
        // ignore
    }
    writeIndex({});
    return { removed: entries.length, sizeFreed };
}
