import { atom, getDefaultStore } from "jotai";
import { TrackPlayerSingleton } from "./trackPlayer";
import { getProxyBase } from "./net";
import { b64urlEncode } from "./ipc";
import { showToast } from "./uiAtoms";
import { callNativeMethod, isNative } from "./native";

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
 * 失败再走伴生代理的 /media 转发流。
 *
 * 下载记录（含完整歌曲元数据）落在 localStorage，「我的下载」页基于它做
 * 播放全部 / 喜欢 / 收藏 / 删除（记录 + 尽力删文件）。
 */

/** 全局同一时间只跑一个下载任务；UI 用它显示进行中状态 */
export const downloadingAtom = atom(false);

/** 当前下载任务：progress 为 0~100，-1 表示不确定（拿不到 content-length，转圈扫描） */
export interface IDownloadTaskState {
    item: IMusic.IMusicItem;
    progress: number;
    /** 批量下载时的序号上下文（第 index / total 首），单曲下载为 null */
    batch: { index: number; total: number } | null;
}

export const downloadTaskAtom = atom<IDownloadTaskState | null>(null);

/** 下载记录版本号：记录增删后自增，驱动「我的下载」页 / 「我的」页数量刷新 */
export const downloadsVersionAtom = atom(0);

let downloading = false;

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

/** 当前原生平台（web 返回 null） */
export function nativePlatform(): "android" | "ios" | null {
    if (!isNative()) {
        return null;
    }
    try {
        const p = (window as any).Capacitor?.getPlatform?.();
        return p === "android" || p === "ios" ? p : null;
    } catch {
        return null;
    }
}

/** 分块大小取 3 的倍数（字节），保证 base64 分块拼接无补位问题 */
const WRITE_CHUNK = 3 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const s = String(reader.result ?? "");
            resolve(s.slice(s.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("读取下载数据失败"));
        reader.readAsDataURL(blob);
    });
}

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

/** Android：经 StoragePlugin 分块写入绝对路径（绕开 Filesystem 插件在 13+ 的公共目录门禁） */
export async function writeAndroidFile(absPath: string, blob: Blob) {
    for (let offset = 0; offset === 0 || offset < blob.size; offset += WRITE_CHUNK) {
        const data = await blobToBase64(blob.slice(offset, offset + WRITE_CHUNK));
        await callNativeMethod("Storage", "writeFile", {
            path: absPath,
            data,
            append: offset > 0,
        });
    }
}

/** iOS：经 Filesystem 插件写入沙盒目录（首块 writeFile 建文件，后续 appendFile 追加） */
export async function writeIosFile(directory: "DOCUMENTS" | "DATA", path: string, blob: Blob) {
    for (let offset = 0; offset === 0 || offset < blob.size; offset += WRITE_CHUNK) {
        const data = await blobToBase64(blob.slice(offset, offset + WRITE_CHUNK));
        if (offset === 0) {
            await callNativeMethod("Filesystem", "writeFile", {
                path,
                directory,
                data,
                recursive: true,
            });
        } else {
            await callNativeMethod("Filesystem", "appendFile", { path, directory, data });
        }
    }
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

async function fetchBlob(
    url: string,
    headers?: Record<string, string>,
    onProgress?: (loaded: number, total: number) => void,
) {
    const resp = await fetch(url, headers && Object.keys(headers).length ? { headers } : undefined);
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

/**
 * 下载一首歌。返回结果供调用方补充处理。
 * @param quality 期望音质档；插件该档不可用时解析器会自动降档，完成提示里带实际档位
 * @param silent 静默模式（批量下载用）：全程不弹 toast（开始/完成/失败都不弹），
 *               进度仍写入 downloadTaskAtom 供列表封面扇形展示
 * @param batchInfo 批量下载序号上下文，展示在「我的下载」页
 */
export async function downloadMusic(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    silent = false,
    batchInfo: { index: number; total: number } | null = null,
): Promise<{ ok: boolean; message?: string }> {
    if (downloading) {
        return { ok: false, message: "已有歌曲在下载中，请稍候" };
    }
    downloading = true;
    const store = getDefaultStore();
    const reportProgress = (progress: number) => {
        store.set(downloadTaskAtom, { item: musicItem, progress, batch: batchInfo });
    };
    store.set(downloadingAtom, true);
    reportProgress(-1);
    if (!silent) {
        showToast(`开始下载「${musicItem.title}」（${qualityShortName(quality)}）`, 3200);
    }
    try {
        const res = await TrackPlayerSingleton.resolveMediaUrl(musicItem, quality);
        if (!res.ok) {
            if (!silent) {
                showToast(res.reason, 3600);
            }
            return { ok: false, message: res.reason };
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
                reportProgress(p);
            }
        };

        let fetched: { blob: Blob; contentType: string };
        try {
            fetched = await fetchBlob(rawUrl, headers, onFetchProgress);
        } catch (e) {
            // 带自定义头的直链被跨域拦截（浏览器/开发者模式）时，走伴生代理的媒体转发流
            const proxyBase = getProxyBase();
            if (!proxyBase) {
                throw e;
            }
            const proxied = `${proxyBase}/media?u=${b64urlEncode(rawUrl)}&h=${b64urlEncode(
                JSON.stringify(headers),
            )}`;
            fetched = await fetchBlob(proxied, undefined, onFetchProgress);
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
        reportProgress(100);
        if (!silent) {
            showToast(message, 3600);
        }
        markDownloaded({
            item: slimItem(musicItem),
            quality: res.quality ?? undefined,
            path: saved.path,
            size: blob.size,
            downloadedAt: Date.now(),
            location: saved.location,
        });
        return { ok: true, message };
    } catch (e: any) {
        const message = e?.message ?? String(e);
        if (!silent) {
            showToast(`下载失败：${message}`, 3600);
        }
        return { ok: false, message };
    } finally {
        downloading = false;
        store.set(downloadingAtom, false);
        store.set(downloadTaskAtom, null);
    }
}

/**
 * 批量下载（多选）：按音质档逐首串行下载，结束播报成功/失败条数。
 */
export async function downloadMusicBatch(
    musicItems: IMusic.IMusicItem[],
    quality: IMusic.IQualityKey,
): Promise<void> {
    if (!musicItems.length) {
        return;
    }
    showToast(`开始批量下载 ${musicItems.length} 首（${qualityShortName(quality)}）`, 2800);
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < musicItems.length; i++) {
        const res = await downloadMusic(musicItems[i], quality, true, {
            index: i + 1,
            total: musicItems.length,
        });
        if (res.ok) {
            okCount += 1;
        } else {
            failCount += 1;
        }
    }
    showToast(
        failCount
            ? `批量下载完成：成功 ${okCount} 首，失败 ${failCount} 首`
            : `批量下载完成：成功 ${okCount} 首`,
        3600,
    );
}
