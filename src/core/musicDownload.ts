import { atom, getDefaultStore } from "jotai";
import {
    setDownloadedSourceResolver,
    TrackPlayerSingleton,
    qualityLadderDown,
    qualityRank,
} from "./trackPlayer";
import { getProxyBase } from "./net";
import { b64urlEncode } from "./ipc";
import { showToast } from "./uiAtoms";
import { callNativeMethod, hasNativeHttp, isNative, localFileUrl, nativeDownloadFile, nativeCancelDownload, nativeHttpRequest, nativePlatform, writeAndroidFile, writeIosFile, yieldToMainIfVisible } from "./native";
import type { INativeDownloadResult } from "./native";

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
 * 解析复用播放器的 resolveMediaUrl：插件缺失/被禁用时能拿到同一套人话原因。
 * 拉流通道（原生端优先级从高到低）：
 *  - 直落磁盘（docs/native-download.md）：HTTP 拉流 + 写盘整体下沉原生线程，
 *    字节完全不过 JS 桥，5 并发下载期间主线程零阻塞；
 *  - 分块 Range 过桥（nativeChunkedDownload）：直落不可用（老 App 包）或失败的回退，
 *    每块过桥在 JS 主线程解析，靠令牌桶限流 + 让渡保流畅；
 *  - 伴生代理 /media 转发流：直链被拦截时的最后回退。
 * 浏览器路径始终走 fetch 流式（+ `<a download>` 保存），与原生互不影响。
 *
 * 下载记录（含完整歌曲元数据）落在 localStorage，「我的下载」页基于它做
 * 播放全部 / 喜欢 / 收藏 / 删除（记录 + 尽力删文件）。
 *
 * 已下载的歌播放时优先播本地文件：findDownloadedLocalSource 经
 * setDownloadedSourceResolver 注册给播放器，任何列表点播已下载的歌都直接读本地，
 * 不再解析线上直链（文件不在 / 播不了时由播放器回退线上）。
 *
 * 下载采用并发队列（最多 5 个同时）：入队即出现在「我的下载」页（排队 / 下载中 / 暂停 / 失败），
 * 展示顺序为最新添加在最上，从序号小（列表顶部）的任务开始下载；
 * 支持整体暂停（中止拉流，继续时重头下载）、停止、失败重试与清除。
 * 任务实时落盘：重启后遗留任务恢复为已暂停（不自动续跑），由用户手动继续。
 *
 * 重复下载去重：同一首歌已有下载记录时，记录音质不低于请求档 → 视为已下载（不再下载）；
 * 请求档更高 → 覆盖下载，完成后旧记录移除、旧文件尽力清理。
 * 失败自动降档：拉流阶段失败时从实际档位往更低档换直链重试（优先往低处拿），
 * 解析成功后立即检查已有记录做「不倒退」校验——已有记录不低于解析档时跳过下载，
 * 避免高音质文件被降档结果覆盖。
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
    /** 添加时间（ms）：统一列表排序锚点，任务完成转入记录时原样继承 */
    addedAt: number;
    /** 添加序号（全局递增）：同一批添加内保持入队顺序 */
    addedSeq: number;
    /** 直落磁盘的目标路径（Android 绝对路径 / iOS 沙盒内相对路径）：
     *  直落下载启动时记录，停止 / 清除失败时按它清理 .part 残留 */
    destPath?: string;
}

/** 下载队列（排队 / 下载中 / 暂停 / 失败的任务）：入队即出现在「我的下载」页，实时落盘、重启恢复 */
export const downloadTasksAtom = atom<IDownloadTask[]>([]);

let queueViewCache: { sig: string; view: IDownloadQueueView } | null = null;

/** 任务队列的结构视图（key / 状态 / 排序锚点，不含进度）：
 *  进度刷新时返回同一对象引用，订阅方（列表页）不会随进度重渲染；
 *  任务行的实时进度由行内自行订阅 downloadTasksAtom 获取 */
export interface IDownloadQueueView {
    tasks: {
        key: string;
        item: IMusic.IMusicItem;
        addedAt: number;
        addedSeq: number;
        status: DownloadTaskStatus;
    }[];
}

export const downloadQueueViewAtom = atom((get) => {
    const tasks = get(downloadTasksAtom);
    const sig = tasks.map((t) => `${t.key}:${t.status}:${t.addedAt}:${t.addedSeq}`).join(",");
    if (queueViewCache?.sig === sig) {
        return queueViewCache.view;
    }
    const view: IDownloadQueueView = {
        tasks: tasks.map((t) => ({
            key: t.key,
            item: t.item,
            addedAt: t.addedAt,
            addedSeq: t.addedSeq,
            status: t.status,
        })),
    };
    queueViewCache = { sig, view };
    return view;
});

/** 批次计数：入队累加 total，任务终结（成功/失败/停止）累加 done，其中成功/失败另计 ok / fail；
 *  队列清空时归零 */
export const downloadCounterAtom = atom({ total: 0, done: 0, ok: 0, fail: 0 });

/** 是否有进行中的下载（排队或下载中）：播放页下载按钮转圈用 */
export const downloadingAtom = atom((get) =>
    get(downloadTasksAtom).some((t) => t.status === "pending" || t.status === "downloading"),
);

/** 下载记录版本号：记录增删后自增，驱动「我的下载」页 / 「我的」页数量刷新 */
export const downloadsVersionAtom = atom(0);

/* ---------- 任务持久化：未完成任务落 localStorage，重启后恢复为暂停态 ---------- */

const TASKS_KEY = "downloadTasks";

/** 全局递增的添加序号：同一批添加内保持入队顺序（展示排序锚点之一） */
let addedSeqCounter = 0;

function writeTasksNow(tasks: IDownloadTask[]) {
    try {
        localStorage.setItem(
            TASKS_KEY,
            JSON.stringify(tasks.map((t) => ({ ...t, item: slimItem(t.item) }))),
        );
    } catch {
        // ignore
    }
}

/** 落盘节流：localStorage 写入是同步 I/O，进度类高频变化若每次都写会拖垮滚动。
 *  结构变化（入队/移除/暂停等状态迁移）立即落盘保关键节点；仅进度变化合并为 1s 一次 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistedSig = "";

function tasksStructSig(tasks: IDownloadTask[]) {
    return tasks.map((t) => `${t.key}:${t.status}`).join(",");
}

function schedulePersistTasks(tasks: IDownloadTask[]) {
    const sig = tasksStructSig(tasks);
    if (sig !== lastPersistedSig) {
        lastPersistedSig = sig;
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        writeTasksNow(tasks);
        return;
    }
    if (!persistTimer) {
        persistTimer = setTimeout(() => {
            persistTimer = null;
            writeTasksNow(getDefaultStore().get(downloadTasksAtom));
        }, 1000);
    }
}

function readPersistedTasks(): IDownloadTask[] {
    try {
        const raw = localStorage.getItem(TASKS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) {
            return [];
        }
        return arr
            .filter(
                (it: any) =>
                    it &&
                    typeof it.key === "string" &&
                    it.item &&
                    typeof it.item === "object" &&
                    typeof it.quality === "string",
            )
            .map(
                (it: any): IDownloadTask => ({
                    key: it.key,
                    item: it.item,
                    quality: it.quality,
                    progress: typeof it.progress === "number" ? it.progress : -1,
                    // 重启不自动续跑：排队/下载中统一恢复为已暂停，失败任务保留待重试
                    status: it.status === "error" ? "error" : "paused",
                    error: typeof it.error === "string" ? it.error : undefined,
                    silent: !!it.silent,
                    addedAt: typeof it.addedAt === "number" ? it.addedAt : Date.now(),
                    addedSeq: typeof it.addedSeq === "number" ? it.addedSeq : 0,
                    destPath: typeof it.destPath === "string" ? it.destPath : undefined,
                }),
            );
    } catch {
        return [];
    }
}

// 启动恢复：上次遗留的任务放回队列（统一为暂停态），等用户手动点继续；
// 之后任务列表的任何变化都同步落盘，队列清空时存储随之清空。
// 只订阅不跑队列 —— 恢复的任务没有 pending，天然不会自动开始下载。
const bootStore = getDefaultStore();
const restoredTasks = readPersistedTasks();
// 续上全局添加序号，避免恢复的任务与新入队任务序号冲突
addedSeqCounter = restoredTasks.reduce((m, t) => Math.max(m, t.addedSeq), 0);
lastPersistedSig = tasksStructSig(restoredTasks);
if (restoredTasks.length) {
    bootStore.set(downloadTasksAtom, restoredTasks);
    // 恢复批次的总览计数：上次失败的任务计入失败数，其余待手动继续
    bootStore.set(downloadCounterAtom, {
        total: restoredTasks.length,
        done: 0,
        ok: 0,
        fail: restoredTasks.filter((t) => t.status === "error").length,
    });
}
bootStore.sub(downloadTasksAtom, () => {
    schedulePersistTasks(bootStore.get(downloadTasksAtom));
});

/** 并发下载上限 */
const MAX_CONCURRENT_DOWNLOADS = 5;
/** 进行中的下载数 */
let activeDownloadCount = 0;
/** 各进行中任务的中止器（暂停 / 停止用），key = 任务键 */
const activeAborts = new Map<string, AbortController>();

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
    /** 添加时间 / 添加序号：继承自下载任务，统一列表排序锚点（旧记录缺省回退 downloadedAt） */
    addedAt?: number;
    addedSeq?: number;
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

/** 记录缓存：写入时同步失效，热路径（批量入队去重 / runTask 降档校验）避免反复解析 localStorage */
let recordsCache: IDownloadRecord[] | null = null;

function readRecords(): IDownloadRecord[] {
    if (recordsCache) {
        return recordsCache;
    }
    try {
        const raw = localStorage.getItem(RECORDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        recordsCache = Array.isArray(arr)
            ? arr.filter((it: any) => it && it.item && typeof it.item === "object")
            : [];
    } catch {
        recordsCache = [];
    }
    return recordsCache;
}

function writeRecords(list: IDownloadRecord[]) {
    recordsCache = list;
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

/** 下载记录列表（新完成的在前） */
export function getDownloadedMusicList(): IDownloadRecord[] {
    return readRecords();
}

/**
 * 查一首歌的下载记录（重复下载判断 / 播放页下载按钮文案用）。
 */
export function getDownloadRecord(
    musicItem: IMusic.IMusicItem,
): IDownloadRecord | undefined {
    return readRecords().find(
        (it) => recordKey(it) === `${musicItem.platform}-${musicItem.id}`,
    );
}

/**
 * 下载成功后记录一首，插到列表最前：与任务区「最新添加在最上」衔接，
 * 串行队列从最早任务开始完成，完成行恰好原位落入记录区，前后位置不变。
 * 同一首重复下载（如高音质覆盖低音质）只保留最新记录并移到最前。
 */
function markDownloaded(record: IDownloadRecord) {
    const list = readRecords();
    const key = recordKey(record);
    writeRecords([record, ...list.filter((it) => recordKey(it) !== key)]);
}

/* ---------- 已下载歌曲的本地播放 ---------- */

/**
 * 播放器解析音源前会问这里（setDownloadedSourceResolver 注册）：
 * 本曲已有可播放的下载文件就返回本地地址，播放不再解析线上直链——
 * 断网可播、秒开、不耗流量。路径换算与 deleteRecordFiles 同规则；
 * 文件已不在（被手动删除等）返回 null，由播放器回退线上解析。
 */
async function findDownloadedLocalSource(
    musicItem: IMusic.IMusicItem,
): Promise<{ src: string; quality: IMusic.IQualityKey | null } | null> {
    const platform = nativePlatform();
    if (!platform) {
        // 浏览器端记录只可能落在系统下载目录，页面读不到文件
        return null;
    }
    const record = readRecords().find(
        (it) => recordKey(it) === `${musicItem.platform}-${musicItem.id}`,
    );
    if (!record) {
        return null;
    }
    try {
        if (platform === "android") {
            let abs = record.path;
            if (!abs.startsWith("/")) {
                // 旧版本记录存相对路径，先换算成绝对路径；system 位置按系统下载目录兜底探测
                const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
                const base =
                    record.location === "data"
                        ? String(dirs.filesDir)
                        : record.location === "external"
                          ? getDownloadExternalDir()
                          : record.location === "system"
                            ? String(dirs.downloads)
                            : String(dirs.documents);
                if (!base) {
                    return null;
                }
                abs = `${base}/${record.path}`;
            }
            // statFile 缺方法（旧 APK）时按存在处理，播放失败有「回退线上」兜底
            const stat = await callNativeMethod("Storage", "statFile", { path: abs }).catch(
                () => null,
            );
            if (stat && stat.exists === false) {
                return null;
            }
            return { src: localFileUrl(abs), quality: record.quality ?? null };
        }
        if (record.location === "system") {
            // iOS 上系统下载通道的文件落点不可靠，播不了本地
            return null;
        }
        // iOS：沙盒内相对路径 → getUri 换算（对不存在的文件会拒绝，顺带充当存在性校验）
        const uri = await callNativeMethod("Filesystem", "getUri", {
            path: record.path,
            directory: record.location === "data" ? "DATA" : "DOCUMENTS",
        });
        const src = String(uri?.uri ?? "");
        return src ? { src, quality: record.quality ?? null } : null;
    } catch (e: any) {
        console.warn("[musicDownload] 查找下载文件的本地音源失败", e?.message ?? e);
        return null;
    }
}

setDownloadedSourceResolver(findDownloadedLocalSource);

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

/** Android 记录路径 → 绝对路径（新记录已是绝对路径原样返回；旧版本相对路径按位置换算，
 *  external 未设置时返回空串表示无法换算）。删除与覆盖判断共用 */
async function androidRecordAbsPath(record: IDownloadRecord): Promise<string> {
    let abs = record.path;
    if (!abs.startsWith("/")) {
        const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
        const base =
            record.location === "data"
                ? String(dirs.filesDir)
                : record.location === "external"
                  ? getDownloadExternalDir()
                  : String(dirs.documents);
        if (!base) {
            return "";
        }
        abs = `${base}/${record.path}`;
    }
    return abs;
}

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
                const abs = await androidRecordAbsPath(record);
                if (!abs) {
                    throw new Error("无法换算旧记录的文件路径");
                }
                await callNativeMethod("Storage", "deleteFile", { path: abs });
                // 尽力清理同名 .part 残留（同名重复下载中断后可能遗留；文件不存在也 resolve）
                await callNativeMethod("Storage", "deleteFile", { path: `${abs}.part` });
            } else {
                await callNativeMethod("Filesystem", "deleteFile", {
                    path: record.path,
                    directory: record.location === "data" ? "DATA" : "DOCUMENTS",
                });
                // 尽力清理同名 .part 残留（不存在时 Filesystem 会拒绝，吞掉即可）
                try {
                    await callNativeMethod("Filesystem", "deleteFile", {
                        path: `${record.path}.part`,
                        directory: record.location === "data" ? "DATA" : "DOCUMENTS",
                    });
                } catch {
                    // ignore
                }
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

/* ---------- 原生直落磁盘下载（优先通道；分块过桥降级为回退） ---------- */

/** 尽力清理直落磁盘的 .part 临时文件（destPath + ".part"），失败不阻断 */
async function cleanupPartFile(destPath: string) {
    const platform = nativePlatform();
    if (!platform) {
        return;
    }
    try {
        if (platform === "android") {
            await callNativeMethod("Storage", "deleteFile", { path: `${destPath}.part` });
        } else {
            // iOS 的 destPath 是沙盒内相对路径，目录按当前保存位置换算（尽力而为）
            await callNativeMethod("Filesystem", "deleteFile", {
                path: `${destPath}.part`,
                directory: getDownloadSaveTarget() === "data" ? "DATA" : "DOCUMENTS",
            });
        }
    } catch {
        // 文件不存在 / 无权限等情况忽略
    }
}

/** 尽力删除直落磁盘已改名的产物文件（如收尾异常留下的 0 字节文件），失败不阻断 */
async function cleanupSavedFile(saved: IDirectDownloadSaved) {
    const platform = nativePlatform();
    if (!platform) {
        return;
    }
    try {
        if (platform === "android") {
            await callNativeMethod("Storage", "deleteFile", { path: saved.path });
        } else {
            await callNativeMethod("Filesystem", "deleteFile", {
                path: saved.path,
                directory: saved.location === "data" ? "DATA" : "DOCUMENTS",
            });
        }
    } catch {
        // ignore
    }
}

/** 直落磁盘的落盘结果（记录语义与 saveBlob 对齐：Android 绝对路径 / iOS 沙盒内相对路径） */
interface IDirectDownloadSaved {
    location: DownloadLocation;
    path: string;
    size: number;
    filename: string;
}

/**
 * 直落磁盘下载的结局：
 *  - unavailable：非原生 / 保存位置为系统下载目录，调用方直接走原路径；
 *  - done：原生端已把文件落到 destPath（.part 已改名），JS 层全程没碰字节；
 *  - failed：直落失败（非中止），.part 已保留供续传，调用方回退分块过桥路径。
 */
type DirectDownloadOutcome =
    | { state: "unavailable" }
    | { state: "done"; saved: IDirectDownloadSaved }
    | { state: "failed"; destPath: string };

/**
 * 原生直落磁盘下载：HTTP 拉流 + 写盘整体下沉原生线程（Android: Storage.downloadFile /
 * iOS: Download.downloadFile），5 路并发不再吃主线程。目录 / 权限 / 文件名语义沿用
 * saveBlob 的 android/ios 分支；中止（暂停/停止）抛 AbortError 交回 runTask 的暂停语义。
 */
async function directNativeDownload(
    key: string,
    url: string,
    headers: Record<string, string>,
    musicItem: IMusic.IMusicItem,
    onProgress: (loaded: number, total: number) => void,
    signal: AbortSignal,
): Promise<DirectDownloadOutcome> {
    const platform = nativePlatform();
    const target = getDownloadSaveTarget();
    if (!platform || target === "system") {
        return { state: "unavailable" };
    }
    // 扩展名先于下载确定（destPath 需要完整文件名）：直链带扩展名直接用；没有时
    // 用一次极小的 HEAD 请求按 content-type 推断（分块路径是下载完拿响应头后验）
    let ext = urlAudioExt(url);
    if (!ext) {
        let contentType = "";
        if (hasNativeHttp()) {
            try {
                const head = await nativeHttpRequest({ url, method: "HEAD", headers });
                contentType = head.headers["content-type"] ?? "";
            } catch {
                // 探测失败按兜底扩展名走
            }
        }
        ext = inferExt(url, contentType);
    }
    const filename = `${sanitizeFilename(`${musicItem.artist} - ${musicItem.title}`)}.${ext}`;

    let destPath = filename;
    let nativeDestPath = filename;
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
            destPath = `${await androidTargetDir(target)}/${filename}`;
            nativeDestPath = destPath;
        } else {
            // external 在 iOS 上不存在（文件夹选择页把浏览选择落成 documents），对齐 saveBlob 分支
            const uri = await callNativeMethod("Filesystem", "getUri", {
                directory: target === "data" ? "DATA" : "DOCUMENTS",
            });
            const base = String(uri?.uri ?? "")
                .replace(/^file:\/\//, "")
                .replace(/\/+$/, "");
            if (!base) {
                throw new Error("无法获取沙盒目录");
            }
            destPath = joinSavePath(getDownloadSubfolder(), filename);
            nativeDestPath = `${base}/${destPath}`;
        }
        // 记录清理锚点：停止 / 清除失败时按 destPath 拼 ".part" 删除残留
        patchTask(key, { destPath });

        // 中止 → 原生端取消（保留 .part 供续传）；完成后监听器随调用结束自动解绑
        const onAbort = () => {
            void nativeCancelDownload(key);
        };
        signal.addEventListener("abort", onAbort);
        let saved: INativeDownloadResult;
        try {
            saved = await nativeDownloadFile(key, url, headers, nativeDestPath, onProgress);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
        return {
            state: "done",
            saved: { location: target, path: destPath, size: saved.size, filename },
        };
    } catch (e) {
        if (signal.aborted) {
            throw e;
        }
        console.warn("[musicDownload] 直落磁盘下载失败，回退分块过桥路径", (e as any)?.message ?? e);
        return { state: "failed", destPath };
    }
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

/** URL 路径里的音频扩展名（直落磁盘下载用：判断是否要按 content-type 补推断） */
function urlAudioExt(url: string): string | null {
    const m = url.split(/[?#]/)[0].match(/\.(mp3|flac|m4a|aac|wav|ogg|opus|ape|wma)$/i);
    return m ? m[1].toLowerCase() : null;
}

/** 扩展名：先看直链路径，再猜 content-type，兜底 mp3 */
function inferExt(url: string, contentType: string) {
    const fromUrl = urlAudioExt(url);
    if (fromUrl) {
        return fromUrl;
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

/** 原生端分块大小：每个分块过桥都要在 JS 主线程同步做 JSON 解析 + base64 解码，
 *  块越大「单次阻塞」越长；512KB 的单次阻塞约几毫秒、落在一帧预算内 */
const NATIVE_DL_CHUNK = 512 * 1024;

/**
 * 过桥限流（全局令牌桶）：分块的桥接解析 + base64 解码是主线程同步开销，
 * 与并发数成正比 —— 5 并发不受限时主线程被推满，整个 App（包括播放器）都会卡。
 * 全局限到每秒 16 块（≈8MB/s 聚合吞吐，30MB 的歌 4 秒左右，远超音乐下载所需），
 * 把主线程占用压到 ~1/5；App 退到后台时界面无人交互，放开限流保吞吐。
 */
const BRIDGE_CHUNKS_PER_SEC = 16;
let bridgeTokens = BRIDGE_CHUNKS_PER_SEC;
let bridgeLastRefill = Date.now();

async function acquireBridgeToken(signal?: AbortSignal) {
    if (document.hidden) {
        return;
    }
    for (;;) {
        const now = Date.now();
        const elapsed = (now - bridgeLastRefill) / 1000;
        if (elapsed > 0) {
            bridgeTokens = Math.min(
                BRIDGE_CHUNKS_PER_SEC,
                bridgeTokens + elapsed * BRIDGE_CHUNKS_PER_SEC,
            );
            bridgeLastRefill = now;
        }
        if (bridgeTokens >= 1) {
            bridgeTokens -= 1;
            return;
        }
        const waitMs = Math.min(
            100,
            Math.ceil(((1 - bridgeTokens) / BRIDGE_CHUNKS_PER_SEC) * 1000),
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (signal?.aborted) {
            throw new DOMException("下载已中止", "AbortError");
        }
    }
}

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
        // 过桥令牌：限制全部并发任务的分块过桥频率，主线程不再被 5 路解析推满
        await acquireBridgeToken(signal);
        const end = Math.min(start + NATIVE_DL_CHUNK - 1, total - 1);
        const part = await requestRange(`bytes=${start}-${end}`);
        if (part.status !== 206) {
            throw new Error(`分块下载失败 (${part.status})`);
        }
        chunks.push(part.data);
        start = end + 1;
        onProgress?.(start, total);
        // 分块之间让出主线程：渲染、输入与音频不被过桥解析饿死
        await yieldToMainIfVisible();
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

/** 计数器：入队累加 total，任务终结（成功/失败/停止移除）累加 done，成功/失败分别累加 ok / fail */
function bumpCounter(dTotal: number, dDone: number, dOk = 0, dFail = 0) {
    const store = getDefaultStore();
    const c = store.get(downloadCounterAtom);
    store.set(downloadCounterAtom, {
        total: c.total + dTotal,
        done: c.done + dDone,
        ok: c.ok + dOk,
        fail: c.fail + dFail,
    });
}

/** 队列清空后归零计数器（下次入队重新开始一批） */
function resetCounterIfIdle() {
    const store = getDefaultStore();
    if (!store.get(downloadTasksAtom).length) {
        store.set(downloadCounterAtom, { total: 0, done: 0, ok: 0, fail: 0 });
    }
}

/** 批量（静默）任务的结果累计，队列排空时统一播报 */
let silentOk = 0;
let silentFail = 0;
/** 批量任务里因「已有不低于本次音质的下载记录」软跳过的数量（入队去重不计，重复添加同一首才走到这） */
let silentSkip = 0;

function flushSilentSummary() {
    if (!silentOk && !silentFail && !silentSkip) {
        return;
    }
    const parts = [`成功 ${silentOk} 首`];
    if (silentFail) {
        parts.push(`失败 ${silentFail} 首`);
    }
    if (silentSkip) {
        parts.push(`${silentSkip} 首已有同音质或更高音质跳过`);
    }
    showToast(
        `批量下载完成：${parts.join("，")}`,
        3600,
    );
    silentOk = 0;
    silentFail = 0;
    silentSkip = 0;
}

/** 入队。去重优先级：已在队列 → 失败原位重置重试（其余状态忽略）；
 *  已有下载记录 → 记录音质不低于请求档视为已下载（rejected=skip），请求档更高则覆盖下载。
 *  返回是否接受入队；rejected = "queued" 已在队列 / "downloaded" 已有不低于请求档的记录 */
export function enqueueDownload(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
    silent = false,
    addedAt = Date.now(),
): { accepted: boolean; reason?: "queued" | "downloaded" } {
    const store = getDefaultStore();
    const key = taskKey(musicItem);
    const existing = store.get(downloadTasksAtom).find((t) => t.key === key);
    if (existing) {
        if (existing.status === "error") {
            // 原位重试：保留 addedAt / addedSeq，行位置与下载次序都不变；失败数同步回退
            patchTask(key, { status: "pending", progress: -1, error: undefined, silent });
            bumpCounter(0, -1, 0, -1);
            pumpQueue();
            return { accepted: true };
        }
        return { accepted: false, reason: "queued" };
    }
    // 已下载去重：记录档 ≥ 请求档 → 已下载过，不重复下载；请求档更高 → 继续下载覆盖旧文件
    const record = getDownloadRecord(musicItem);
    if (record?.quality && qualityRank(record.quality) >= qualityRank(quality)) {
        return { accepted: false, reason: "downloaded" };
    }
    store.set(downloadTasksAtom, (prev) => [
        ...prev,
        {
            key,
            item: musicItem,
            quality,
            progress: -1,
            status: "pending",
            silent,
            addedAt,
            addedSeq: ++addedSeqCounter,
        },
    ]);
    bumpCounter(1, 0);
    pumpQueue();
    return { accepted: true };
}

/**
 * 下载一首歌（入队）。立即出现在「我的下载」页，完成后落入下载记录。
 * @param quality 期望音质档；插件该档不可用时解析器会自动降档，完成提示里带实际档位
 */
export function downloadMusic(musicItem: IMusic.IMusicItem, quality: IMusic.IQualityKey): void {
    const res = enqueueDownload(musicItem, quality, false);
    if (res.accepted) {
        showToast(`已加入下载队列「${musicItem.title}」（${qualityShortName(quality)}）`, 2800);
    } else if (res.reason === "downloaded") {
        showToast(`「${musicItem.title}」已下载过不重复下载，需更高音质请在播放页重新选择`, 3200);
    } else {
        showToast(`「${musicItem.title}」已在下载队列中`, 2400);
    }
}

/** 批量下载（多选）：按音质档入队并发下载，同一次添加共用 addedAt（批次内保持所选顺序） */
export function downloadMusicBatch(musicItems: IMusic.IMusicItem[], quality: IMusic.IQualityKey): void {
    if (!musicItems.length) {
        return;
    }
    let added = 0;
    let skippedDownloaded = 0;
    const addedAt = Date.now();
    for (const item of musicItems) {
        const res = enqueueDownload(item, quality, true, addedAt);
        if (res.accepted) {
            added += 1;
        } else if (res.reason === "downloaded") {
            skippedDownloaded += 1;
        }
    }
    const parts = [`已加入下载队列 ${added} 首（${qualityShortName(quality)}）`];
    if (skippedDownloaded) {
        parts.push(`${skippedDownloaded} 首已下载过（音质不低于本次）已跳过`);
    }
    if (added || skippedDownloaded) {
        showToast(parts.join("，"), 2800);
    } else {
        showToast("所选歌曲都已在下载队列中", 2400);
    }
}

/** 任务成功收尾（直落磁盘与 blob 路径共用）：落记录 → 进度走满 → 移出队列 → 计数/播报 */
function settleTaskSuccess(
    key: string,
    ctx: { item: IMusic.IMusicItem; silent: boolean; addedAt: number; addedSeq: number },
    resolvedQuality: IMusic.IQualityKey | null | undefined,
    filename: string,
    saved: { location: DownloadLocation; path: string },
    size: number,
) {
    const store = getDefaultStore();
    const sizeText =
        size > 1024 * 1024
            ? `${(size / 1024 / 1024).toFixed(1)}MB`
            : `${Math.max(1, Math.round(size / 1024))}KB`;
    const actualQuality = resolvedQuality ? qualityShortName(resolvedQuality) : "默认";
    const message =
        saved.location === "system"
            ? `下载完成：${filename}（${actualQuality} · ${sizeText}）`
            : `下载完成：已保存到${downloadSaveTargetLabel(saved.location)}（${actualQuality} · ${sizeText}）`;
    markDownloaded({
        item: slimItem(ctx.item),
        quality: resolvedQuality ?? undefined,
        path: saved.path,
        size,
        downloadedAt: Date.now(),
        addedAt: ctx.addedAt,
        addedSeq: ctx.addedSeq,
        location: saved.location,
    });
    // 成功：进度走满（灰底收完）后移出队列并计数
    patchTask(key, { progress: 100 });
    store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.key !== key));
    bumpCounter(0, 1, 1);
    if (ctx.silent) {
        silentOk += 1;
    } else {
        showToast(message, 3600);
    }
}

/** fetchAndSave 的结局：done = 已落记录并移出队列；failed = 拉流失败（未中止、未落盘），
 *  附带错误信息与失败直落尝试的 destPath（供换档重试前清理 .part） */
type FetchAndSaveOutcome =
    | { state: "done" }
    | { state: "failed"; error: string; directDestPath?: string };

/**
 * 拉流并落盘（runTask 的拉流主体，失败交回 runTask 决定是否降档重试）：
 *  - 网络拉流失败 → failed（换更低音质可能拿到可用直链，由 runTask 降档）；
 *  - 落盘 / 收尾失败（磁盘问题，换音质救不了）→ 直接抛出交失败收尾；
 *  - 成功 → 落记录、移出队列，并尽力清理被覆盖下载替换掉的旧文件（done）。
 */
async function fetchAndSave(
    key: string,
    ctx: { item: IMusic.IMusicItem; silent: boolean; addedAt: number; addedSeq: number },
    opts: {
        url: string;
        headers: Record<string, string>;
        quality: IMusic.IQualityKey | null;
        onFetchProgress: (loaded: number, total: number) => void;
        signal: AbortSignal;
    },
): Promise<FetchAndSaveOutcome> {
    const { url, headers, quality, onFetchProgress, signal } = opts;
    const musicItem = ctx.item;
    let direct: DirectDownloadOutcome = { state: "unavailable" };
    // 拉流阶段失败才值得降档重试；进入落盘阶段后的失败直接抛出
    let saving = false;
    try {
        // 原生直落磁盘优先（docs/native-download.md）：字节不过 JS 桥，5 并发不占主线程。
        // 原生方法缺失（老 App 包）或下载失败时回退下方分块过桥路径，浏览器路径不受影响
        direct = await directNativeDownload(key, url, headers, musicItem, onFetchProgress, signal);
        if (direct.state === "done") {
            // size=0 说明原生端收尾异常（文件实际不在目标位置），不能当成功落记录；
            // 清掉异常产物后按拉流失败处理交回 runTask（降档重试时直落仍坏会自然落到分块路径）
            if (!direct.saved.size) {
                void cleanupSavedFile(direct.saved);
                throw new Error("下载落盘异常（文件大小为 0）");
            }
            const previous = getDownloadRecord(musicItem);
            settleTaskSuccess(
                key,
                ctx,
                quality,
                direct.saved.filename,
                { location: direct.saved.location, path: direct.saved.path },
                direct.saved.size,
            );
            cleanupReplacedFile(previous, {
                location: direct.saved.location,
                path: direct.saved.path,
            }).catch(() => undefined);
            return { state: "done" };
        }

        let fetched: { blob: Blob; contentType: string };
        try {
            fetched = await fetchBlob(url, headers, onFetchProgress, signal);
        } catch (e) {
            if (signal.aborted) {
                throw e;
            }
            // 带自定义头的直链被跨域拦截（浏览器/开发者模式）时，走伴生代理的媒体转发流
            const proxyBase = getProxyBase();
            if (!proxyBase) {
                throw e;
            }
            const proxied = `${proxyBase}/media?u=${b64urlEncode(url)}&h=${b64urlEncode(
                JSON.stringify(headers),
            )}`;
            fetched = await fetchBlob(proxied, undefined, onFetchProgress, signal);
        }

        const { blob, contentType } = fetched;
        // 直落失败转回退的：分块路径不读 .part，拿到完整数据后 .part 即为死重，尽早清掉
        if (direct.state === "failed") {
            void cleanupPartFile(direct.destPath);
        }
        const filename = `${sanitizeFilename(`${musicItem.artist} - ${musicItem.title}`)}.${inferExt(
            url,
            contentType,
        )}`;
        saving = true;
        const saved = await saveBlob(filename, blob);
        const previous = getDownloadRecord(musicItem);
        settleTaskSuccess(key, ctx, quality, filename, saved, blob.size);
        cleanupReplacedFile(previous, saved).catch(() => undefined);
        return { state: "done" };
    } catch (e: any) {
        if (signal.aborted || saving) {
            // 中止交回暂停语义；落盘阶段失败换音质救不了，原样抛出按任务失败收尾
            throw e;
        }
        return {
            state: "failed",
            error: e?.message ?? String(e),
            directDestPath: direct.state === "failed" ? direct.destPath : undefined,
        };
    }
}

/**
 * 高音质覆盖下载后，尽力清理旧记录指向的旧文件：
 * 旧文件本就在系统下载目录（删不到）或与新房物为同一文件时跳过；否则删旧文件。
 * 注意 Android 旧版本记录存相对路径，须先换算成绝对路径再比较，
 * 否则「相对旧路径 vs 绝对新路径」会误判成不同文件，把刚下的新文件删掉。
 */
async function cleanupReplacedFile(
    previous: IDownloadRecord | undefined,
    saved: { location: DownloadLocation; path: string },
) {
    if (!previous || previous.location === "system") {
        return;
    }
    const platform = nativePlatform();
    if (previous.location === saved.location) {
        if (platform === "android") {
            const prevAbs = await androidRecordAbsPath(previous);
            if (prevAbs && prevAbs === saved.path) {
                return;
            }
        } else if (previous.path === saved.path) {
            return;
        }
    }
    try {
        await deleteRecordFiles([previous]);
    } catch {
        // ignore
    }
}

/** 执行单个任务：解析 → 下载（直落磁盘优先，分块过桥回退）→ 落记录。
 *  失败自动降档：拉流阶段失败从实际档位往更低档换直链重拉（优先往低处拿），
 *  换档前清掉旧 .part（不同档位常是不同直链 / 扩展名，续传会拼出坏文件）；
 *  解析阶段失败不降档（resolveMediaUrl 内部已按阶梯降过）。
 *  落盘前做「不倒退」校验：已有下载记录不低于本次解析档时软跳过，防高音质被降档结果覆盖。 */
async function runTask(key: string) {
    const store = getDefaultStore();
    const task = store.get(downloadTasksAtom).find((t) => t.key === key);
    if (!task || task.status !== "pending") {
        return;
    }
    const { item: musicItem, quality, silent, addedAt, addedSeq } = task;
    const ctx = { item: musicItem, silent, addedAt, addedSeq };
    const abort = new AbortController();
    activeAborts.set(key, abort);
    patchTask(key, { status: "downloading", progress: -1, error: undefined });
    try {
        // 下载取直链不看本地下载（ignoreLocalDownload）：重复下载要从音源重新拉取，
        // 而不是把已下载的本地文件又当成音源写回自己
        const res = await TrackPlayerSingleton.resolveMediaUrl(musicItem, quality, undefined, {
            ignoreLocalDownload: true,
        });
        if (!res.ok) {
            throw new Error(res.reason);
        }

        // 进度播报节流：百分比没变不写 atom；并发下载时再按时间限频（每个任务 ~2.5 次/秒），
        // 避免高频 patch 造成整页重渲染、列表滑动卡顿
        let lastProgress = -1;
        let lastTickAt = 0;
        const onFetchProgress = (loaded: number, total: number) => {
            if (total <= 0) {
                return;
            }
            const p = Math.min(97, 2 + Math.round((loaded / total) * 95));
            const now = Date.now();
            if (p !== lastProgress && now - lastTickAt >= 400) {
                lastProgress = p;
                lastTickAt = now;
                patchTask(key, { progress: p });
            }
        };

        // 拉流失败自动降档重试：从解析出的实际档位往更低档逐档换直链再试（优先往低处拿）。
        // quality 为 null 的直链没有档位信息，无法定位阶梯，只试当前一次
        let url = res.source?.url ?? res.src;
        let headers: Record<string, string> = {};
        let source = res.source ?? {};
        let resolvedQuality = res.quality;
        const triedQualities: string[] = [];
        for (;;) {
            headers = { ...source.headers };
            if (source.userAgent && !Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) {
                headers["User-Agent"] = source.userAgent;
            }
            // 不倒退校验（每轮解析后查记录）：已有下载记录的音质不低于本次解析档，
            // 用户已经拿到过更好的文件，按更差的拉下来覆盖是倒退 —— 软跳过
            const existing = getDownloadRecord(musicItem);
            if (
                existing?.quality &&
                resolvedQuality &&
                qualityRank(existing.quality) >= qualityRank(resolvedQuality)
            ) {
                patchTask(key, { progress: 100 });
                store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.key !== key));
                bumpCounter(0, 1, 1);
                if (silent) {
                    silentSkip += 1;
                } else {
                    showToast(
                        `「${musicItem.title}」已下载过（${qualityShortName(existing.quality)}），无需重复下载`,
                        3200,
                    );
                }
                return;
            }
            const outcome = await fetchAndSave(key, ctx, {
                url,
                headers,
                quality: resolvedQuality,
                onFetchProgress,
                signal: abort.signal,
            });
            if (outcome.state === "done") {
                return;
            }
            // 拉流失败：清 .part（换档常换直链，续传会拼出坏文件）后往更低档换直链重试；
            // 没有更低档（或直链无档位信息）就把错误交失败收尾
            triedQualities.push(resolvedQuality ? QUALITY_LABEL[resolvedQuality] : "默认音源");
            const lower = resolvedQuality
                ? qualityLadderDown(resolvedQuality)[1]
                : undefined;
            if (!lower) {
                throw new Error(outcome.error);
            }
            // 等待删除完成再重试：直落路径按 .part 续传，删干净才能避免新旧直链拼接
            if (outcome.directDestPath) {
                await cleanupPartFile(outcome.directDestPath);
            }
            const retry = await TrackPlayerSingleton.resolveMediaUrl(musicItem, lower, url, {
                ignoreLocalDownload: true,
            });
            if (!retry.ok || !(retry.source?.url ?? retry.src)) {
                const reason = retry.ok ? "没有可用音源" : retry.reason;
                throw new Error(
                    `${outcome.error}（已尝试${triedQualities.join("、")}；${QUALITY_LABEL[lower]}：${reason}）`,
                );
            }
            url = retry.source?.url ?? retry.src;
            source = retry.source ?? {};
            resolvedQuality = retry.quality;
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
            bumpCounter(0, 1, 0, 1);
            if (silent) {
                silentFail += 1;
            } else {
                showToast(`下载失败：${message}`, 3600);
            }
        }
    } finally {
        activeAborts.delete(key);
    }
}

/** 下一个该开始的任务：展示顺序为最新添加在最上（addedAt 倒序、同批按添加序号），
 *  即从序号小（列表顶部）的任务开始下载 */
function nextPendingTask(): IDownloadTask | undefined {
    return getDefaultStore()
        .get(downloadTasksAtom)
        .filter((t) => t.status === "pending")
        .sort((a, b) => b.addedAt - a.addedAt || a.addedSeq - b.addedSeq)[0];
}

/** 一批任务结束后的收尾：队列真正排空（只剩失败/暂停）才播报批量汇总并复位计数 */
function notifyQueueSettled() {
    const rest = getDefaultStore().get(downloadTasksAtom);
    if (
        !rest.some(
            (t) => t.status === "pending" || t.status === "downloading" || t.status === "paused",
        )
    ) {
        flushSilentSummary();
        resetCounterIfIdle();
    }
}

/** 并发调度：把进行中的下载补满到上限；每个任务结束后自动补位，直到没有待下载任务 */
function pumpQueue() {
    const store = getDefaultStore();
    for (;;) {
        if (activeDownloadCount >= MAX_CONCURRENT_DOWNLOADS) {
            return;
        }
        const next = nextPendingTask();
        if (!next) {
            return;
        }
        activeDownloadCount += 1;
        // runTask 的同步前缀会先把任务置为 downloading，循环下一圈不会重复选中
        void runTask(next.key).finally(() => {
            activeDownloadCount -= 1;
            notifyQueueSettled();
            pumpQueue();
        });
    }
}

/** 一键暂停：中止所有拉流，下载中与排队中的任务都标记为已暂停（继续时重头下载） */
export function pauseAllDownloads() {
    const store = getDefaultStore();
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) =>
            t.status === "pending" || t.status === "downloading" ? { ...t, status: "paused" } : t,
        ),
    );
    activeAborts.forEach((abort) => abort.abort());
}

/** 一键继续：所有已暂停任务重新排队 */
export function resumeAllDownloads() {
    const store = getDefaultStore();
    store.set(downloadTasksAtom, (prev) =>
        prev.map((t) => (t.status === "paused" ? { ...t, status: "pending", progress: -1 } : t)),
    );
    pumpQueue();
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
    activeAborts.forEach((abort) => abort.abort());
    // 直落磁盘的任务尽力清理 .part 残留（停止后任务不存在，续传锚点一并移除）
    for (const t of removed) {
        if (t.destPath) {
            void cleanupPartFile(t.destPath);
        }
    }
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
    bumpCounter(0, -1, 0, -1);
    pumpQueue();
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
    bumpCounter(0, -failed, 0, -failed);
    pumpQueue();
}

/** 清除全部失败任务 */
export function clearFailedDownloads() {
    const store = getDefaultStore();
    const failedTasks = store.get(downloadTasksAtom).filter((t) => t.status === "error");
    if (!failedTasks.length) {
        return;
    }
    store.set(downloadTasksAtom, (prev) => prev.filter((t) => t.status !== "error"));
    // 失败任务的 .part 本为重试续传保留，任务被清除即失去归属，尽力一并清理
    for (const t of failedTasks) {
        if (t.destPath) {
            void cleanupPartFile(t.destPath);
        }
    }
    bumpCounter(-failedTasks.length, -failedTasks.length, 0, -failedTasks.length);
    resetCounterIfIdle();
}
