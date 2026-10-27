/**
 * 应用检查更新
 *
 * 更新数据源是 Gitee 公开仓库：版本清单 update.json 走 raw 直链（匿名可访问，
 * 服务端缓存 60~300 秒，发版后最多延迟几分钟生效），APK 挂同仓库的 Release 附件
 * （网页上传，单文件上限 100MB）。客户端只做只读 GET，零 token、零 API 调用。
 *
 * 流程：拉清单 → versionCode 比较原生读到的安装包版本 → 弹更新面板（uiAtoms）→
 * 复用 StoragePlugin 直落磁盘下载（进度事件 / .part 断点续传，手动跟随 gitee.com →
 * raw.giteeusercontent.com 一类的 302）→ AppUpdate 插件拉起安装器。
 * 仅原生环境启用：浏览器没有 APK 分发意义，也拿不到真实安装包版本。
 */

import { compare } from "compare-versions";
import { getConfig, setConfig } from "./appConfig";
import { APP_VERSION } from "./backup";
import { netFetchText } from "./net";
import {
    callNativeMethod,
    hasNativeHttp,
    isNative,
    nativeCancelDownload,
    nativeDownloadFile,
    nativeHttpRequest,
} from "./native";
import { closeUpdateSheet, openUpdateSheet, showToast } from "./uiAtoms";

/**
 * 版本清单地址：Gitee 公开仓库 raw 直链（发版只改仓库里的 update.json，代码不变）。
 *
 * 两个渠道各一条清单、互不可见：正式包拉 update.json，debug 包（applicationId
 * 带 .debug 后缀）拉 update-debug.json。这样试验性构建可以先行发出去自测，
 * 不会提示正式用户；正式发版也不打扰 debug 渠道。
 */
const UPDATE_MANIFEST_STABLE_URL =
    "https://gitee.com/huaihui/MusicFreeHy/raw/main/update.json";
const UPDATE_MANIFEST_DEBUG_URL =
    "https://gitee.com/huaihui/MusicFreeHy/raw/main/update-debug.json";

/** 本机渠道：debug 包 applicationId 以 .debug 结尾（build.gradle 的 applicationIdSuffix） */
export type UpdateChannel = "stable" | "debug";

let cachedChannel: UpdateChannel | null = null;

export async function getUpdateChannel(): Promise<UpdateChannel> {
    if (cachedChannel) {
        return cachedChannel;
    }
    if (isNative()) {
        try {
            const res = await callNativeMethod("AppUpdate", "getAppVersion");
            const pkg = String(res?.packageName ?? "");
            cachedChannel = pkg.endsWith(".debug") ? "debug" : "stable";
            return cachedChannel;
        } catch {
            // 读不到按正式渠道处理
        }
    }
    cachedChannel = "stable";
    return cachedChannel;
}

export interface IUpdateManifest {
    versionCode: number;
    versionName: string;
    changelog: string;
    apkUrl: string;
    /** 发布日期（YYYY-MM-DD），面板展示用 */
    publishedAt?: string;
    /** 可选强制更新门槛：低于它的本机版本不给「稍后 / 忽略」，面板不可关闭 */
    minVersionCode?: number;
}

export interface ILocalVersion {
    versionCode: number;
    versionName: string;
}

/** 「忽略此版本」记录（设备本地偏好，不进备份白名单）：启动自动检查不再提示该版本 */
const IGNORED_VERSION_KEY = "update.ignoredVersionCode";

/** 下载通道的任务 ID（原生 downloadProgress 事件按它过滤；与歌曲下载任务不共用命名） */
const UPDATE_TASK_ID = "app-update-apk";

/** 更新包是否正在下载（「稍后再说」关面板时要不要顺手取消下载，靠它判断） */
let updateDownloading = false;

export function isUpdateDownloading(): boolean {
    return updateDownloading;
}

/** 本机安装包版本：原生读 PackageInfo（唯一权威来源）；读不到 / 浏览器回退 APP_VERSION */
export async function getLocalVersion(): Promise<ILocalVersion> {
    if (isNative()) {
        try {
            const res = await callNativeMethod("AppUpdate", "getAppVersion");
            if (res && res.versionName) {
                return {
                    versionCode: Number(res.versionCode) || 0,
                    versionName: String(res.versionName),
                };
            }
        } catch (e) {
            console.warn("[update] 读取本机版本失败，回退内置版本号", e);
        }
    }
    return { versionCode: 0, versionName: APP_VERSION };
}

/** 解析并校验清单：versionCode / versionName / apkUrl 必填，坏字段直接抛错走失败分支 */
export function parseManifest(raw: string): IUpdateManifest {
    const data = JSON.parse(raw);
    const versionCode = Number(data?.versionCode);
    const versionName = typeof data?.versionName === "string" ? data.versionName.trim() : "";
    const apkUrl = typeof data?.apkUrl === "string" ? data.apkUrl.trim() : "";
    if (!Number.isFinite(versionCode) || versionCode <= 0) {
        throw new Error("清单缺少有效 versionCode");
    }
    if (!versionName || !apkUrl) {
        throw new Error("清单缺少 versionName / apkUrl");
    }
    const minVersionCode = Number(data?.minVersionCode);
    return {
        versionCode,
        versionName,
        changelog: typeof data?.changelog === "string" ? data.changelog : "",
        apkUrl,
        publishedAt: typeof data?.publishedAt === "string" ? data.publishedAt : undefined,
        minVersionCode:
            Number.isFinite(minVersionCode) && minVersionCode > 0 ? minVersionCode : undefined,
    };
}

/** 拉清单：原生环境必须走 nativeHttpRequest —— CapacitorHttp 劫持的 fetch 原生侧
 *  不跟随 302（gitee raw 会 302 到 raw.giteeusercontent.com），直接拿 302 会误报失败 */
async function fetchManifestText(url: string): Promise<string> {
    if (isNative() && hasNativeHttp()) {
        const res = await nativeHttpRequest({ url, method: "GET", timeoutMs: 15000 });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`请求失败 (${res.status})`);
        }
        return res.text;
    }
    return netFetchText(url, 15000);
}

export interface ICheckUpdateResult {
    /** null = 无新版本（或静默模式下被忽略） */
    manifest: IUpdateManifest | null;
    local: ILocalVersion;
}

/**
 * 检查更新：拉清单并与本机版本比较。versionCode 为唯一权威；
 * code 相同时比较 versionName，兜住历史包 versionName 写法差异（如 "1.0" vs "1.0.0"）。
 * 每次启动都会检查（无节流）；「忽略此版本」只对启动自动检查生效，手动检查仍会弹出。
 */
export async function checkForUpdate(
    options: { manual?: boolean } = {},
): Promise<ICheckUpdateResult> {
    const local = await getLocalVersion();
    const channel = await getUpdateChannel();
    const raw = await fetchManifestText(
        channel === "debug" ? UPDATE_MANIFEST_DEBUG_URL : UPDATE_MANIFEST_STABLE_URL,
    );
    const manifest = parseManifest(raw);
    const isNewer =
        manifest.versionCode > local.versionCode ||
        (manifest.versionCode === local.versionCode &&
            compare(manifest.versionName, local.versionName, ">"));
    if (!isNewer) {
        return { manifest: null, local };
    }
    if (!options.manual && manifest.versionCode === Number(getConfig(IGNORED_VERSION_KEY, 0))) {
        return { manifest: null, local };
    }
    return { manifest, local };
}

/** 设置页手动检查：无新版 / 失败直接 toast，有新版弹面板 */
export async function manualCheckForUpdate(): Promise<void> {
    try {
        const { manifest, local } = await checkForUpdate({ manual: true });
        if (!manifest) {
            showToast(`已是最新版本（v${local.versionName}）`);
            return;
        }
        openUpdateSheet({ manifest, local });
    } catch (e) {
        console.warn("[update] 手动检查失败", e);
        showToast("检查更新失败，请稍后重试");
    }
}

/** 启动自动检查入口（App 挂载后延时调用）：任何失败静默吞掉，有新版才弹面板 */
export async function silentCheckForUpdate(): Promise<void> {
    try {
        const { manifest } = await checkForUpdate({ manual: false });
        if (manifest) {
            openUpdateSheet({ manifest, local: await getLocalVersion() });
        }
    } catch (e) {
        console.warn("[update] 启动自动检查失败", e);
    }
}

/** 记「忽略此版本」：静默检查不再提示该 versionCode，手动检查仍会弹出 */
export function ignoreUpdateVersion(manifest: IUpdateManifest) {
    setConfig(IGNORED_VERSION_KEY, manifest.versionCode);
}

/** 下载更新包到应用私有目录（原生直落磁盘 + 进度回调；中断后同路径续传） */
export async function downloadUpdateApk(
    manifest: IUpdateManifest,
    onProgress: (loaded: number, total: number) => void,
): Promise<string> {
    const res = await callNativeMethod("AppUpdate", "getApkSavePath", {
        versionName: manifest.versionName,
    });
    const destPath = String(res?.path ?? "");
    if (!destPath) {
        throw new Error("无法确定安装包保存路径");
    }
    updateDownloading = true;
    try {
        const result = await nativeDownloadFile(
            UPDATE_TASK_ID,
            manifest.apkUrl,
            { "User-Agent": `MusicFreeHy/${manifest.versionName}` },
            destPath,
            onProgress,
        );
        return result.path;
    } finally {
        updateDownloading = false;
    }
}

/** 中断更新包下载（.part 保留供续传；任务不存在时幂等成功） */
export async function cancelUpdateDownload(): Promise<void> {
    await nativeCancelDownload(UPDATE_TASK_ID);
}

/** 拉起系统安装器；needPermission=true 表示已跳「允许安装未知应用」授权页，授权后重调 */
export async function installUpdateApk(
    path: string,
): Promise<{ needPermission?: boolean }> {
    const res = await callNativeMethod("AppUpdate", "installApk", { path });
    return res ?? {};
}

/** 是否已获「安装未知应用」授权：面板在授权页返回后先预检，已授权才自动续装 */
export async function canInstallApk(): Promise<boolean> {
    try {
        const res = await callNativeMethod("AppUpdate", "canInstall");
        return !!res?.granted;
    } catch {
        return false;
    }
}

/** 「稍后再说」：下载中先取消（.part 保留），再关面板 */
export async function dismissUpdateSheet(downloading: boolean) {
    if (downloading) {
        await cancelUpdateDownload().catch(() => undefined);
    }
    closeUpdateSheet();
}
