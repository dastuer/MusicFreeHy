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
    isNative,
    nativeCancelDownload,
    nativeDownloadFile,
} from "./native";
import { closeUpdateSheet, openUpdateSheet, showToast } from "./uiAtoms";

/** 版本清单地址：Gitee 公开仓库 raw 直链（发版只改仓库里的 update.json，代码不变） */
const UPDATE_MANIFEST_URL = "https://gitee.com/<owner>/<repo>/raw/master/update.json";

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

/** 上次启动自动检查时间戳（24h 节流）；忽略的版本号；均为设备本地偏好，不进备份白名单 */
const LAST_AUTO_CHECK_KEY = "update.lastAutoCheckAt";
const IGNORED_VERSION_KEY = "update.ignoredVersionCode";
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

export interface ICheckUpdateResult {
    /** null = 无新版本（或静默模式下被忽略） */
    manifest: IUpdateManifest | null;
    local: ILocalVersion;
}

/**
 * 检查更新：拉清单并与本机版本比较。versionCode 为唯一权威；
 * code 相同时比较 versionName，兜住历史包 versionName 写法差异（如 "1.0" vs "1.0.0"）。
 * 静默模式 24h 节流且跳过已忽略版本；手动检查不受限。
 */
export async function checkForUpdate(
    options: { manual?: boolean } = {},
): Promise<ICheckUpdateResult> {
    const local = await getLocalVersion();
    const now = Date.now();
    if (!options.manual) {
        const last = Number(getConfig(LAST_AUTO_CHECK_KEY, 0));
        if (now - last < AUTO_CHECK_INTERVAL_MS) {
            return { manifest: null, local };
        }
    }
    const raw = await netFetchText(UPDATE_MANIFEST_URL, 15000);
    const manifest = parseManifest(raw);
    setConfig(LAST_AUTO_CHECK_KEY, now);
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
    } catch {
        // 静默失败：无网 / 清单未部署 / 老包缺插件，都不打扰用户
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

/** 「稍后再说」：下载中先取消（.part 保留），再关面板 */
export async function dismissUpdateSheet(downloading: boolean) {
    if (downloading) {
        await cancelUpdateDownload().catch(() => undefined);
    }
    closeUpdateSheet();
}
