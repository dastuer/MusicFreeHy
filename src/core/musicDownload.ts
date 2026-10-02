import { atom, getDefaultStore } from "jotai";
import { TrackPlayerSingleton } from "./trackPlayer";
import { getProxyBase } from "./net";
import { b64urlEncode } from "./ipc";
import { showToast } from "./uiAtoms";
import { callNativeMethod, hasNativeHttp, isNative, nativePlatform, writeAndroidFile, writeIosFile } from "./native";

/**
 * 歌曲下载：音质选档 → 插件解析原始直链 → 拉成 blob → 保存到本机。
 *
 * 保存位置由「设置 → 下载 → 保存位置」决定，在文件夹选择页里浏览 / 新建后选定：
 *  - 系统下载目录（默认）：浏览器通道 blob + <a download>（与备份导出同一保存方式）；
 *  - Android：目标目录（浏览选出的任意文件夹 / 文档目录 / 应用私有目录）统一换算成
 *    绝对路径走 StoragePlugin 分块写入，公共目录需要「所有文件访问」权限；
 *  - iOS：documents / data 走 Filesystem 插件沙盒目录。
 *  - 插件写入失败自动回退系统下载通道。
 *
 * 解析复用播放器的 resolveMediaUrl：插件缺失/被禁用时能拿到同一套人话原因；
 * 拉流优先直连（CapacitorHttp 接管 fetch，无跨域限制、可带自定义请求头），
 * 失败再走伴生代理的 /media 转发流。原生端响应没有流式 body，
 * 走分块 Range 下载换取真实进度（见 nativeChunkedDownload）。
 *
 * 下载记录（含完整歌曲元数据）落在 localStorage，「我的下载」页基于它做
 * 播放全部 / 喜欢 / 收藏 / 删除（记录 + 尽力删文件）。
 *
 * 下载采用串行队列：入队即出现在「我的下载」页（排队 / 下载中 / 暂停 / 失败），
 * 支持整体暂停（中止当前拉流，继续时重头下载当前首）、停止、失败重试与清除。
 */

/** 下载任务状态：pending 排队中 / downloading 下载中 / paused 已暂停 / error 失败待重试 */
export type DownloadTaskStatus = "pending" | "downloading" | "paused" | "error";

export interface IDownloadTask {
    /** platform-id，任务唯一键 */
    key: string;
    item: IMusic.IMusicItem;
    quality: IMusic.IQualityKey;
    /** 0~100；-1 表示不确定（拿不到 content-length） */
    progress: number;
    status: DownloadTaskStatus;
    /** 失败原因（status = error 时展示） */
    error?: string;
    /** 静默任务（批量下载）：完成/失败不弹单条 toast，队列排空后统一汇总 */
    silent: boolean;
}

/** 下载队列（排队 / 下载中 / 暂停 / 失败的任务）：入队即出现在「我的下载」页 */
export const downloadTasksAtom = atom<IDownloadTask[]>([]);

/** 批次计数：入队累加 total，任务终结（成功/失败/停止）累加 done；队列清空时归零 */
export const downloadCounterAtom = atom({ total: 0, done: 0 });

/** 是否有进行中的下载（排队或下载中）：播放页下载按钮转圈用 */
export const downloadingAtom = atom((get) =>
    get(downloadTasksAtom).some((t) => t.status === "pending" || t.status === "downloading"),
);

/** 下载记录版本号：记录增删后自增，驱动「我的下载」页 / 「我的」页数量刷新 */
export const downloadsVersionAtom = atom(0);

let queueRunning = false;
/** 中止当前下载任务的拉流（暂停 / 停止用） */
let currentAbort: AbortController | null = null;

/* ---------- 下载记录（「我的下载」页） ---------- */

/** 文件实际保存位置（external = Android 上浏览选择的任意文件夹，存绝对路径） */
export type DownloadLocation = "system" | "documents" | "data" | "external";

export interface IDownloadRecord {
    item: IMusic.IMusicItem;
    /** 实际下载音质档（解析器降档后与期望档可能不同） */
    quality?: IMusic.IQualityKey;
    /** 写入插件时的相对路径（含子文件夹与文件名）；system 位置仅文件名 */
    path: string;
    size: number;
    downloadedAt: number;
    location: DownloadLocation;
}

const RECORDS_KEY = "downloadedMusicList";

/** 大体积内联封面不落盘（与桌面端 / musicSheet 同规则） */
const MAX_PERSISTED_ARTWORK = 64 * 1024;

function slimItem(item: IMusic.IMusicItem): IMusic.IMusicItem {
    if (typeof item.artwork === "string" && item.artwork.length > MAX_PERSISTED_ARTWORK) {
        return { ...item, artwork: "" };
    }
    return item;
}

function readRecords(): IDownloadRecord[] {
    try {
        const raw = localStorage.getItem(RECORDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) {
            return [];
        }
        return arr.filter((it: any) => it && it.item && typeof it.item === "object");
    } catch {
        return [];
    }
}

function writeRecords(list: IDownloadRecord[]) {
    try {
        localStorage.setItem(RECORDS_KEY, JSON.stringify(list));
    } catch {
        // ignore
    }
    bumpDownloadsVersion();
}

function bumpDownloadsVersion() {
    const store = getDefaultStore();
    store.set(downloadsVersionAtom, store.get(downloadsVersionAtom) + 1);
}

function recordKey(record: IDownloadRecord) {
    return `${record.item.platform}-${record.item.id}`;
}

/** 下载记录列表（新下载在前） */
export function getDownloadedMusicList(): IDownloadRecord[] {
    return readRecords();
}

/** 下载成功后记录一首；同一首重复下载只保留最新记录 */
function markDownloaded(record: IDownloadRecord) {
    const list = readRecords();
    const key = recordKey(record);
    writeRecords([record, ...list.filter((it) => recordKey(it) !== key)]);
}

/* ---------- 删除（记录 + 尽力删文件） ---------- */

export interface IRemoveDownloadResult {
    removed: number;
    /** 插件写入的文件删除成功数 */
    fileDeleted: number;
    /** 插件写入的文件删除失败数 */
    fileFailed: number;
    /** 保存在系统下载目录的记录数（文件删不掉，需手动清理） */
    systemLeft: number;
}

const EMPTY_REMOVE_RESULT: IRemoveDownloadResult = {
    removed: 0,
    fileDeleted: 0,
    fileFailed: 0,
    systemLeft: 0,
};

/** 删除插件写入的文件（documents / data / external），尽力而为，单文件失败不阻断 */
async function deleteRecordFiles(records: IDownloadRecord[]) {
    if (!isNative()) {
        // Web 环境记录只可能是 system 位置（saveBlob 在非原生时一律走浏览器通道）
        return { fileDeleted: 0, fileFailed: 0 };
    }
    const platform = nativePlatform();
    let fileDeleted = 0;
    let fileFailed = 0;
    for (const record of records) {
        if (record.location === "system") {
            continue;
        }
        try {
            if (platform === "android") {
                // 统一走 StoragePlugin 绝对路径删除；旧版本记录存的是相对路径，先换算
                let abs = record.path;
                if (!abs.startsWith("/")) {
                    const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
                    const base =
                        record.location === "data"
                            ? String(dirs.filesDir)
                            : record.location === "external"
                              ? getDownloadExternalDir()
                              : String(dirs.documents);
                    abs = `${base}/${record.path}`;
                }
                await callNativeMethod("Storage", "deleteFile", { path: abs });
            } else {
                await callNativeMethod("Filesystem", "deleteFile", {
                    path: record.path,
                    directory: record.location === "data" ? "DATA" : "DOCUMENTS",
                });
            }
            fileDeleted += 1;
        } catch (e: any) {
            console.warn(`[musicDownload] 删除文件失败：${record.path}`, e?.message ?? e);
            fileFailed += 1;
        }
    }
    return { fileDeleted, fileFailed };
}

/** 批量删除下载记录（插件写入的文件一并删除） */
export async function removeDownloadRecords(
    musicItems: IMusic.IMusicItem[],
): Promise<IRemoveDownloadResult> {
    const keys = new Set(musicItems.map((it) => `${it.platform}-${it.id}`));
    const list = readRecords();
    const removedRecords = list.filter((it) => keys.has(recordKey(it)));
    if (!removedRecords.length) {
        return EMPTY_REMOVE_RESULT;
    }
    const { fileDeleted, fileFailed } = await deleteRecordFiles(removedRecords);
    writeRecords(list.filter((it) => !keys.has(recordKey(it))));
    return {
        removed: removedRecords.length,
        fileDeleted,
        fileFailed,
        systemLeft: removedRecords.filter((it) => it.location === "system").length,
    };
}

/** 清空全部下载记录（文件处理同上） */
export async function clearDownloadRecords(): Promise<IRemoveDownloadResult> {
    const list = readRecords();
    if (!list.length) {
        return EMPTY_REMOVE_RESULT;
    }
    const { fileDeleted, fileFailed } = await deleteRecordFiles(list);
    writeRecords([]);
    return {
        removed: list.length,
        fileDeleted,
        fileFailed,
        systemLeft: list.filter((it) => it.location === "system").length,
    };
}

/* ---------- 存储路径设置（设置页 / 文件夹选择页读写） ---------- */

export type DownloadSaveTarget = "system" | "documents" | "data" | "external";

const SAVE_TARGET_KEY = "download.saveTarget";
const SUBFOLDER_KEY = "download.subfolder";
const EXTERNAL_DIR_KEY = "download.externalDir";
const DEFAULT_SUBFOLDER = "MusicFree";

export function getDownloadSaveTarget(): DownloadSaveTarget {
    const raw = localStorage.getItem(SAVE_TARGET_KEY);
    return raw === "documents" || raw === "data" || raw === "external" ? raw : "system";
}

export function setDownloadSaveTarget(target: DownloadSaveTarget) {
    localStorage.setItem(SAVE_TARGET_KEY, target);
}

/** 子文件夹支持多级路径（文件夹选择页选出）；"." 表示所选目录的根目录 */
export function getDownloadSubfolder(): string {
    return localStorage.getItem(SUBFOLDER_KEY)?.trim() || DEFAULT_SUBFOLDER;
}

export function setDownloadSubfolder(name: string) {
    const trimmed = name.trim();
    if (trimmed) {
        localStorage.setItem(SUBFOLDER_KEY, trimmed);
    }
}

/** 「浏览选择」的自定义目录（绝对路径，仅 Android）；iOS 上浏览选择落成 documents + 相对路径 */
export function getDownloadExternalDir(): string {
    return localStorage.getItem(EXTERNAL_DIR_KEY)?.trim().replace(/\/+$/, "") || "";
}

export function setDownloadExternalDir(absPath: string) {
    const cleaned = absPath.trim().replace(/\/+$/, "");
    if (cleaned.startsWith("/")) {
        localStorage.setItem(EXTERNAL_DIR_KEY, cleaned);
    }
}

/** 子目录相对路径 → 存储值：空 / "." 记为 "."（根目录），其余去掉首尾斜杠原样保留 */
export function normalizeSubfolder(relPath: string): string {
    const cleaned = relPath.trim().replace(/^\/+|\/+$/g, "");
    return !cleaned || cleaned === "." ? "." : cleaned;
}

/** 拼相对路径 + 文件名；根目录（"."）直接用文件名 */
function joinSavePath(subfolder: string, filename: string): string {
    return !subfolder || subfolder === "." ? filename : `${subfolder}/${filename}`;
}

/** 展示用：内部存储绝对路径缩写成「内部存储/…」 */
export function prettyAbsDir(absPath: string): string {
    return absPath.replace(/^\/storage\/emulated\/0/, "内部存储") || absPath;
}

function dirLabel(root: string, subfolder: string): string {
    return !subfolder || subfolder === "." ? `${root}（根目录）` : `${root} / ${subfolder}`;
}

/** 设置页回显用：保存位置的展示名（含完整子路径） */
export function downloadSaveTargetLabel(target = getDownloadSaveTarget()): string {
    if (target === "documents") {
        return dirLabel("文档目录", getDownloadSubfolder());
    }
    if (target === "data") {
        return dirLabel("应用私有目录", getDownloadSubfolder());
    }
    if (target === "external") {
        const dir = getDownloadExternalDir();
        return dir ? prettyAbsDir(dir) : "系统下载目录";
    }
    return "系统下载目录";
}

/* ---------- 保存通道 ---------- */

/** 按设置解析 Android 端的目标目录（绝对路径），写入与删除共用 */
async function androidTargetDir(target: DownloadSaveTarget): Promise<string> {
    if (target === "external") {
        const dir = getDownloadExternalDir();
        if (!dir) {
            throw new Error("未设置自定义目录");
        }
        return dir;
    }
    const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
    const subfolder = getDownloadSubfolder();
    const base = target === "documents" ? String(dirs.documents) : String(dirs.filesDir);
    return subfolder === "." ? base : `${base}/${subfolder}`;
}

function triggerBrowserDownload(filename: string, blob: Blob) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 大文件留给 WebView 一点读取余量，再释放引用
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/**
 * 按设置写入一个文件，返回落盘位置与路径（记录 / 删除用）。
 * - Android：目标目录统一换算成绝对路径走 StoragePlugin；公共目录没有「所有文件访问」
 *   权限时在这里失败，由调用方回退系统下载通道。
 * - iOS：documents / data 走 Filesystem 插件沙盒目录（external 在 iOS 上不存在，
 *   文件夹选择页把浏览选择落成 documents + 相对路径）。
 * - 默认 / 失败回退浏览器下载通道。
 */
async function saveBlob(
    filename: string,
    blob: Blob,
): Promise<{ location: DownloadLocation; path: string }> {
    const target = getDownloadSaveTarget();
    const platform = nativePlatform();
    if (target !== "system" && platform) {
        try {
            if (platform === "android") {
                if (target !== "data") {
                    const perm = await callNativeMethod("Storage", "requestWritePermission");
                    if (!perm?.granted) {
                        throw new Error(
                            perm?.needAllFiles ? "需要「所有文件访问」权限" : "未授予存储写入权限",
                        );
                    }
                }
                const path = `${await androidTargetDir(target)}/${filename}`;
                await writeAndroidFile(path, blob);
                return { location: target, path };
            }
            const path = joinSavePath(getDownloadSubfolder(), filename);
            await writeIosFile(target === "data" ? "DATA" : "DOCUMENTS", path, blob);
            return { location: target, path };
        } catch (e: any) {
            console.warn("[musicDownload] 插件写入失败，回退系统下载通道", e?.message ?? e);
        }
    }
    triggerBrowserDownload(filename, blob);
    return { location: "system", path: filename };
}

/* ---------- 音质档位 ---------- */

/** 音质档位显示名 */
export const QUALITY_LABEL: Record<IMusic.IQualityKey, string> = {
    low: "流畅音质",
    standard: "标准音质",
    high: "极高音质",
    super: "无损音质",
};

/** 音质档位的短名（toast / 按钮用） */
export function qualityShortName(q: IMusic.IQualityKey) {
    return QUALITY_LABEL[q].replace("音质", "");
}

/** 音质描述里的文件大小：数字按字节格式化，字符串（"12.3MB"）原样展示 */
export function formatQualitySize(size?: string | number) {
    if (size === undefined || size === null || size === "") {
        return undefined;
    }
    if (typeof size === "number") {
        return size > 1024 * 1024
            ? `${(size / 1024 / 1024).toFixed(1)}MB`
            : `${Math.max(1, Math.round(size / 1024))}KB`;
    }
    return String(size);
}

function sanitizeFilename(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "music";
}

/** 扩展名：先看直链路径，再猜 content-type，兜底 mp3 */
function inferExt(url: string, contentType: string) {
    const m = url.split(/[?#]/)[0].match(/\.(mp3|flac|m4a|aac|wav|ogg|opus|ape|wma)$/i);
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
        "audio/m4a": "m4a",
        "audio/aac": "aac",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
    };
    return table[(contentType || "").split(";")[0].trim().toLowerCase()] ?? "mp3";
}

/* ---------- 原生端分块下载（真实进度） ---------- */

/** 原生端分块大小：兼顾进度粒度与桥接开销（数据以 base64 过桥） */
const NATIVE_DL_CHUNK = 512 * 1024;

function nativeHttpPlugin(): any {
    try {
        return (window as any).Capacitor?.Plugins?.CapacitorHttp;
    } catch {
        return null;
    }
}

/**
 * 原生端下载：CapacitorHttp 接管 fetch 后响应没有可读流（进度永远拿不到），
 * 改走分块 Range 请求 —— 先用 bytes=0-0 探测总大小（206 的 Content-Range），
 * 再逐块拉取拼成 Blob，每块结束上报一次真实进度。
 * 服务器不支持 Range（探测返回 200 整包）时直接用探测响应完成下载。
 */
async function nativeChunkedDownload(
    url: string,
    headers: Record<string, string>,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
): Promise<{ blob: Blob; contentType: string }> {
    const http = nativeHttpPlugin();
    if (!http?.request) {
        throw new Error("原生 HTTP 不可用");
    }
    if (signal?.aborted) {
        throw new DOMException("下载已中止", "AbortError");
    }
    const requestRange = async (range?: string) => {
        const res = await http.request({
            url,
            method: "GET",
            headers: range ? { ...headers, Range: range } : headers,
            responseType: "arraybuffer",
            connectTimeout: 20000,
            readTimeout: 60000,
        });
        if (res.status >= 400) {
            throw new Error(`请求失败 (${res.status})`);
        }
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {})) {
            resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
        }
        return {
            status: Number(res.status),
            headers: resHeaders,
            data: res.data as ArrayBuffer,
        };
    };

    // 探测总大小：206 → Content-Range 带总大小，分块拉；200 → 服务器不支持 Range，响应即整包
    const probe = await requestRange("bytes=0-0");
    const contentType = probe.headers["content-type"] ?? "";
    if (probe.status !== 206) {
        const size = probe.data?.byteLength ?? 0;
        onProgress?.(size, size);
        return { blob: new Blob([probe.data], { type: contentType }), contentType };
    }
    const total = Number((probe.headers["content-range"] ?? "").split("/")[1]) || 0;
    if (!total) {
        // 拿不到总大小：整包拉取，进度走不确定态
        const full = await requestRange();
        const size = full.data?.byteLength ?? 0;
        onProgress?.(size, size);
        return { blob: new Blob([full.data], { type: contentType }), contentType };
    }

    // 分块拉取：probe 已含第 0 字节，从 1 开始；每块结束检查中止信号（暂停/停止）
    const chunks: ArrayBuffer[] = [probe.data];
    for (let start = 1; start < total; ) {
        if (signal?.aborted) {
            throw new DOMException("下载已中止", "AbortError");
        }
        const end = Math.min(start + NATIVE_DL_CHUNK - 1, total - 1);
        const part = await requestRange(`bytes=${start}-${end}`);
        if (part.status !== 206) {
            throw new Error(`分块下载失败 (${part.status})`);
        }
        chunks.push(part.data);
        start = end + 1;
        onProgress?.(start, total);
    }
    return { blob: new Blob(chunks, { type: contentType }), contentType };
}

async function fetchBlob(
    url: string,
    headers?: Record<string, string>,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
) {
    // 原生端：CapacitorHttp 接管 fetch，响应没有可读流，直接走分块 Range 下载换真实进度
    if (isNative() && hasNativeHttp()) {
        return nativeChunkedDownload(url, headers ?? {}, onProgress, signal);
    }
    const resp = await fetch(url, {
        ...(headers && Object.keys(headers).length ? { headers } : undefined),
        signal,
    });
    if (!resp.ok) {
        throw new Error(`请求失败 (${resp.status})`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (!onProgress || !resp.body) {
        // 拿不到可读流（如原生端 CapacitorHttp 接管 fetch）：退回整包拉取，进度走不确定态
        return { blob: await resp.blob(), contentType };
    }
    // 流式读取：按 content-length 换算百分比，拿不到长度时调用方显示不确定态
    const total = Number(resp.headers.get("content-length")) || 0;
    const reader = resp.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let loaded = 0;
    for (;;) {
        if (signal?.aborted) {
            try {
                await reader.cancel();
            } catch {
                // ignore
            }
            throw new DOMException("下载已中止", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value.slice().buffer);
        loaded += value.length;
        onProgress(loaded, total);
    }
    return { blob: new Blob(chunks, { type: contentType }), contentType };
}

/* ---------- 下载队列执行器 ---------- */

function taskKey(item: IMusic.IMusicItem) {
    return `${item.platform}-${item.id}`;
}

function patchTask(key: string, patch: Partial<IDownloadTask>) {
    const store = getDefaultStore();
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    );
}

/** 计数器：入队累加 total，任务终结（成功/失败/停止移除）累加 done */
function bumpCounter(dTotal: number, dDone: number) {
    const store = getDefaultStore();
    const c = store.get(downloadCounterAtom);
    store.set(downloadCounterAtom, { total: c.total + dTotal, done: c.done + dDone });
}

/** 队列清空后归零计数器（下次入队重新开始一批） */
function resetCounterIfIdle() {
    const store = getDefaultStore();
    if (!store.get(downloadTasksAtom).length) {
        store.set(downloadCounterAtom, { total: 0, done: 0 });
    }
}

/** 批量（静默）任务的结果累计，队列排空时统一播报 */
let silentOk = 0;
let silentFail = 0;

function flushSilentSummary() {
    if (!silentOk && !silentFail) {
        return;
    }
    showToast(
        silentFail
            ? `批量下载完成：成功 ${silentOk} 首，失败 ${silentFail} 首`
            : `批量下载完成：成功 ${silentOk} 首`,
        3600,
    );
    silentOk = 0;
    silentFail = 0;
}

/** 入队。同一首歌已在队列时：失败的重置为待下载，进行中的忽略；返回是否接受 */
export function enqueueDownload(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    silent = false,
): boolean {
    const store = getDefaultStore();
    const key = taskKey(musicItem);
    const existing = store.get(downloadTasksAtom).find((t) => t.key === key);
    if (existing) {
        if (existing.status === "error") {
            patchTask(key, { status: "pending", progress: -1, error: undefined, silent });
            bumpCounter(0, -1);
            void runQueue();
            return true;
        }
        return false;
    }
    store.set(downloadTasksAtom, (prev) => [
        ...prev,
        { key, item: musicItem, quality, progress: -1, status: "pending", silent },
    ]);
    bumpCounter(1, 0);
    void runQueue();
    return true;
}

/**
 * 下载一首歌（入队）。立即出现在「我的下载」页，完成后落入下载记录。
 * @param quality 期望音质档；插件该档不可用时解析器会自动降档，完成提示里带实际档位
 */
export function downloadMusic(musicItem: IMusic.IMusicItem, quality: IMusic.IQualityKey): void {
    if (enqueueDownload(musicItem, quality, false)) {
        showToast(`已加入下载队列「${musicItem.title}」（${qualityShortName(quality)}）`, 2800);
    } else {
        showToast(`「${musicItem.title}」已在下载队列中`, 2400);
    }
}

/** 批量下载（多选）：按音质档入队串行下载，队列排空时播报成功/失败条数 */
export function downloadMusicBatch(musicItems: IMusic.IMusicItem[], quality: IMusic.IQualityKey): void {
    if (!musicItems.length) {
        return;
    }
    let added = 0;
    for (const item of musicItems) {
        if (enqueueDownload(item, quality, true)) {
            added += 1;
        }
    }
    if (added) {
        showToast(`已加入下载队列 ${added} 首（${qualityShortName(quality)}）`, 2800);
    } else {
        showToast("所选歌曲都已在下载队列中", 2400);
    }
}

/** 执行单个任务：解析 → 拉流 → 保存 → 落记录 */
async function runTask(key: string) {
    const store = getDefaultStore();
    const task = store.get(downloadTasksAtom).find((t) => t.key === key);
    if (!task || task.status !== "pending") {
        return;
    }
    const { item: musicItem, quality, silent } = task;
    const abort = new AbortController();
    currentAbort = abort;
    patchTask(key, { status: "downloading", progress: -1, error: undefined });
    try {
        const res = await TrackPlayerSingleton.resolveMediaUrl(musicItem, quality);
        if (!res.ok) {
            throw new Error(res.reason);
        }

        const source = res.source ?? {};
        const rawUrl = source.url ?? res.src;
        const headers: Record<string, string> = { ...(source.headers ?? {}) };
        if (source.userAgent && !Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) {
            headers["User-Agent"] = source.userAgent;
        }

        // 进度播报节流：百分比没变就不写 atom，避免高频刷渲染
        let lastProgress = -1;
        const onFetchProgress = (loaded: number, total: number) => {
            if (total <= 0) {
                return;
            }
            const p = Math.min(97, 2 + Math.round((loaded / total) * 95));
            if (p !== lastProgress) {
                lastProgress = p;
                patchTask(key, { progress: p });
            }
        };

        let fetched: { blob: Blob; contentType: string };
        try {
            fetched = await fetchBlob(rawUrl, headers, onFetchProgress, abort.signal);
        } catch (e) {
            if (abort.signal.aborted) {
                throw e;
            }
            // 带自定义头的直链被跨域拦截（浏览器/开发者模式）时，走伴生代理的媒体转发流
            const proxyBase = getProxyBase();
            if (!proxyBase) {
                throw e;
            }
            const proxied = `${proxyBase}/media?u=${b64urlEncode(rawUrl)}&h=${b64urlEncode(
                JSON.stringify(headers),
            )}`;
            fetched = await fetchBlob(proxied, undefined, onFetchProgress, abort.signal);
        }

        const { blob, contentType } = fetched;
        const filename = `${sanitizeFilename(`${musicItem.artist} - ${musicItem.title}`)}.${inferExt(
            rawUrl,
            contentType,
        )}`;
        const saved = await saveBlob(filename, blob);

        const sizeText =
            blob.size > 1024 * 1024
                ? `${(blob.size / 1024 / 1024).toFixed(1)}MB`
                : `${Math.max(1, Math.round(blob.size / 1024))}KB`;
        const actualQuality = res.quality ? qualityShortName(res.quality) : "默认";
        const message =
            saved.location === "system"
                ? `下载完成：${filename}（${actualQuality} · ${sizeText}）`
                : `下载完成：已保存到${downloadSaveTargetLabel(saved.location)}（${actualQuality} · ${sizeText}）`;
        markDownloaded({
            item: slimItem(musicItem),
            quality: res.quality ?? undefined,
            path: saved.path,
            size: blob.size,
            downloadedAt: Date.now(),
            location: saved.location,
        });
        // 成功：进度走满（灰底收完）后移出队列并计数
        patchTask(key, { progress: 100 });
        store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.key !== key));
        bumpCounter(0, 1);
        if (silent) {
            silentOk += 1;
        } else {
            showToast(message, 3600);
        }
    } catch (e: any) {
        if (abort.signal.aborted) {
            // 暂停/停止已先行改写状态或移除任务；这里兜底：仍在下载中的标记回暂停
            const cur = store.get(downloadTasksAtom).find((t) => t.key === key);
            if (cur && cur.status === "downloading") {
                patchTask(key, { status: "paused" });
            }
        } else {
            const message = e?.message ?? String(e);
            patchTask(key, { status: "error", error: message });
            bumpCounter(0, 1);
            if (silent) {
                silentFail += 1;
            } else {
                showToast(`下载失败：${message}`, 3600);
            }
        }
    } finally {
        if (currentAbort === abort) {
            currentAbort = null;
        }
    }
}

/** 串行执行队列：取下一个 pending 任务跑，直到没有为止 */
async function runQueue() {
    if (queueRunning) {
        return;
    }
    queueRunning = true;
    try {
        for (;;) {
            const next = getDefaultStore()
                .get(downloadTasksAtom)
                .find((t) => t.status === "pending");
            if (!next) {
                break;
            }
            await runTask(next.key);
        }
    } finally {
        queueRunning = false;
        // 队列真正排空（只剩失败项或为空）才播报批量汇总；暂停退出时保留计数
        const rest = getDefaultStore().get(downloadTasksAtom);
        if (!rest.some((t) => t.status === "pending" || t.status === "downloading" || t.status === "paused")) {
            flushSilentSummary();
        }
        resetCounterIfIdle();
    }
}

/** 一键暂停：中止当前拉流，当前首与排队中的任务都标记为已暂停（继续时当前首从头下载） */
export function pauseAllDownloads() {
    const store = getDefaultStore();
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) =>
            t.status === "pending" || t.status === "downloading" ? { ...t, status: "paused" } : t,
        ),
    );
    currentAbort?.abort();
}

/** 一键继续：所有已暂停任务重新排队 */
export function resumeAllDownloads() {
    const store = getDefaultStore();
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) => (t.status === "paused" ? { ...t, status: "pending", progress: -1 } : t)),
    );
    void runQueue();
}

/** 停止下载：移除所有未失败的任务（失败任务保留，可单独重试/清除） */
export function stopAllDownloads() {
    const store = getDefaultStore();
    const removed = store
        .get(downloadTasksAtom)
        .filter((t) => t.status === "pending" || t.status === "downloading" || t.status === "paused");
    if (!removed.length) {
        return;
    }
    store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.status === "error"));
    bumpCounter(0, removed.length);
    currentAbort?.abort();
    showToast("已停止下载任务", 2400);
    resetCounterIfIdle();
}

/** 重试单个失败任务 */
export function retryDownloadTask(key: string) {
    const store = getDefaultStore();
    const task = store.get(downloadTasksAtom).find((t) => t.key === key);
    if (!task || task.status !== "error") {
        return;
    }
    patchTask(key, { status: "pending", progress: -1, error: undefined });
    bumpCounter(0, -1);
    void runQueue();
}

/** 重试全部失败任务 */
export function retryFailedDownloads() {
    const store = getDefaultStore();
    const failed = store.get(downloadTasksAtom).filter((t) => t.status === "error").length;
    if (!failed) {
        return;
    }
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) =>
            t.status === "error" ? { ...t, status: "pending", progress: -1, error: undefined } : t,
        ),
    );
    bumpCounter(0, -failed);
    void runQueue();
}

/** 清除全部失败任务 */
export function clearFailedDownloads() {
    const store = getDefaultStore();
    const failed = store.get(downloadTasksAtom).filter((t) => t.status === "error").length;
    if (!failed) {
        return;
    }
    store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.status !== "error"));
    bumpCounter(-failed, -failed);
    resetCounterIfIdle();
}
