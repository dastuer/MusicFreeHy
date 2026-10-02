/**
 * 原生环境（Capacitor）适配层
 *
 * 浏览器里跑的是纯 Web；打包成 Android/iOS 原生应用后：
 *  - 主线程 fetch 被 CapacitorHttp 接管（无跨域限制、可带任意请求头）；
 *  - Worker 里的插件请求通过 pluginHost 的 net 通道转发到主线程原生 HTTP；
 *  - 状态栏样式由这里统一设置。
 */

export function isNative(): boolean {
    try {
        return !!(window as any).Capacitor?.isNativePlatform?.();
    } catch {
        return false;
    }
}

/** 主线程是否可用原生 HTTP（CapacitorHttp 插件已启用） */
export function hasNativeHttp(): boolean {
    if (!isNative()) {
        return false;
    }
    try {
        const Cap = (window as any).Capacitor;
        return !!Cap?.Plugins?.CapacitorHttp;
    } catch {
        return false;
    }
}

export interface INativeHttpResult {
    status: number;
    headers: Record<string, string>;
    text: string;
}

/** 视为重定向、需要改写请求继续跟随的状态码 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 重定向跟随上限（对齐 Node follow-redirects / 浏览器的默认量级） */
const MAX_REDIRECT_HOPS = 10;

/** CapacitorHttp 单次请求（不处理重定向） */
async function rawNativeRequest(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}): Promise<INativeHttpResult> {
    const Cap = (window as any).Capacitor;
    const res = await Cap.Plugins.CapacitorHttp.request({
        url: options.url,
        method: options.method.toUpperCase(),
        headers: options.headers ?? {},
        data: options.body ?? undefined,
        responseType: "text",
        connectTimeout: Math.min(options.timeoutMs ?? 20000, 60000),
        readTimeout: Math.min(options.timeoutMs ?? 20000, 60000),
    });
    const headers: Record<string, string> = {};
    const rawHeaders = res.headers ?? {};
    for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return {
        status: res.status,
        headers,
        text: typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? ""),
    };
}

/**
 * 主线程原生 HTTP 请求（仅在 hasNativeHttp() 时调用），带重定向跟随。
 *
 * 必须在 JS 侧自己跟随：Android 的 CapacitorHttp 底层 HttpURLConnection
 * 不跟随 https→http 跨协议重定向（网易 outer-url 等直链正是这种 302），
 * 插件拿到裸 302 会把「未跟随的跳转链接」当成解析结果——表现就是 VIP 歌曲
 * 只能播 30 秒试听、下载失败。桌面端（Node follow-redirects）和原版 RN
 * （OkHttp 跟随）都会透明跟完重定向，这里对齐同一语义。
 * iOS 的 NSURLSession 本身会跟完，此循环不会触发额外请求。
 */
export async function nativeHttpRequest(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}): Promise<INativeHttpResult> {
    let url = options.url;
    let method = (options.method ?? "GET").toUpperCase();
    let body = options.body;
    for (let hop = 0; ; hop += 1) {
        const res = await rawNativeRequest({ ...options, url, method, body });
        const location = res.headers["location"];
        let next: string | null = null;
        if (location && hop < MAX_REDIRECT_HOPS) {
            try {
                next = new URL(location, url).toString();
            } catch {
                // Location 无法解析：按无重定向处理，把当前响应原样交给调用方
            }
        }
        if (!next || !REDIRECT_STATUSES.has(res.status)) {
            return res;
        }
        if (method !== "GET" && method !== "HEAD" && res.status !== 307 && res.status !== 308) {
            // 301/302/303 对非幂等方法按浏览器语义降级为 GET 并丢弃请求体
            method = "GET";
            body = undefined;
        }
        url = next;
    }
}

/**
 * 原生环境的系统栏样式（暗色底、浅色图标）。
 * Android 15+ 强制 edge-to-edge，系统栏透明、由页面背景直接透出
 * （颜色与图标由 capacitor.config.ts 的 SystemBars 配置负责，不需要运行时调用）；
 * 这里只剩 iOS 需要显式设置状态栏样式。
 * 旧实现里的 StatusBar.setBackgroundColor / NavigationBar.setBackgroundColor
 * 在 Android 15+ 已失效（前者还会抛错），已移除。
 */
export async function setupNativeStatusBar() {
    if (!isNative()) {
        return;
    }
    try {
        const Cap = (window as any).Capacitor;
        const StatusBar = Cap.Plugins?.StatusBar;
        if (StatusBar && Cap.getPlatform?.() === "ios") {
            await StatusBar.setStyle({ style: "DARK" });
        }
    } catch (e) {
        console.warn("[native] 状态栏样式设置失败", e);
    }
}

/**
 * 监听原生插件事件（如 @capacitor/app 的 backButton）。
 *
 * 这里直接走注入进 WebView 的 bridge（`Capacitor.addListener`），
 * 而不是 `import { App } from "@capacitor/app"`：后者会把 @capacitor/core 的
 * JS 运行时打进包体，而原生插件的 JS 侧其实只需要一个转发通道。
 * 返回解绑函数；浏览器环境返回空实现。
 */
export function addNativeListener(
    pluginName: string,
    eventName: string,
    callback: (data: any) => void,
): () => void {
    if (!isNative()) {
        return () => {};
    }
    try {
        const Cap = (window as any).Capacitor;
        const handle = Cap?.addListener?.(pluginName, eventName, callback);
        return () => {
            try {
                handle?.remove?.();
            } catch (e) {
                console.warn("[native] 移除事件监听失败", pluginName, eventName, e);
            }
        };
    } catch (e) {
        console.warn("[native] 事件监听失败", pluginName, eventName, e);
        return () => {};
    }
}

/** 调用原生插件方法（仅在 isNative() 时调用，走 bridge 的 nativePromise） */
export async function callNativeMethod(
    pluginName: string,
    methodName: string,
    options: Record<string, any> = {},
): Promise<any> {
    const Cap = (window as any).Capacitor;
    return Cap.nativePromise(pluginName, methodName, options);
}

/**
 * 设备本地文件路径 → WebView 能加载的地址（Capacitor 的 _capacitor_file_ 通道）。
 * 与 @capacitor/core 的 convertFileSrc 同规则（androidScheme 为 https，见 capacitor.config.ts）。
 * 非原生环境返回空串；封面图 / <audio> 播放本地文件都走它。
 */
export function localFileUrl(absPath: string): string {
    if (!absPath || !isNative()) {
        return "";
    }
    try {
        const platform = (window as any).Capacitor?.getPlatform?.();
        if (platform === "android") {
            return `https://localhost/_capacitor_file_${absPath}`;
        }
        if (platform === "ios") {
            return `capacitor://localhost/_capacitor_file_${absPath}`;
        }
    } catch {
        // ignore
    }
    return `file://${absPath}`;
}

/** 当前原生平台（web 返回 null）；写文件通道按它分流 */
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

/* ---------- 文件写入（下载 / 本地音乐标签 / 播放缓存共用） ---------- */

/** 分块大小取 3 的倍数（字节），保证 base64 分块拼接无补位问题。
 *  每块过桥要在 JS 主线程同步编解码 + 桥接序列化，块越小单次阻塞越短（约 1MB ≈ 几毫秒），
 *  下载写盘 / 缓存写盘才不会冻结界面 */
export const WRITE_CHUNK = Math.floor((1024 * 1024) / 3) * 3;

export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const s = String(reader.result ?? "");
            resolve(s.slice(s.indexOf(",") + 1));
        };
        reader.onerror = () => reject(new Error("读取文件数据失败"));
        reader.readAsDataURL(blob);
    });
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
        // 写块之间让出主线程，连续写大文件时不冻结界面
        await yieldToMainIfVisible();
    }
}

/** iOS：经 Filesystem 插件写入沙盒目录（首块 writeFile 建文件，后续 appendFile 追加） */
export async function writeIosFile(directory: "DOCUMENTS" | "DATA" | "CACHE", path: string, blob: Blob) {
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
        await yieldToMainIfVisible();
    }
}

/** 让出主线程一拍：给渲染、输入与音频留出处理窗口。
 *  页面在后台时定时器被钳制到 1s+，会让分块下载/写盘近乎停摆 —— 此时跳过让渡保吞吐 */
export function yieldToMainIfVisible(): Promise<void> {
    if (document.hidden) {
        return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---------- 原生直落磁盘下载（docs/native-download.md） ---------- */

/**
 * 直落磁盘下载的插件名：Android 复用 StoragePlugin，iOS 用独立的 DownloadPlugin。
 * 两端语义对齐：流式写 destPath + ".part"（支持 Range 续传），进度经 downloadProgress
 * 事件回传，成功后改名 destPath 并 resolve { path, size, contentType }。
 */
function downloadPluginName(): string {
    return nativePlatform() === "ios" ? "Download" : "Storage";
}

export interface INativeDownloadResult {
    path: string;
    size: number;
    /** 响应 Content-Type（扩展名推断用，部分服务器拿不到） */
    contentType?: string;
}

/**
 * 原生直落磁盘下载：HTTP 拉流 + 写盘整体在原生线程完成，下载字节完全不过 JS 桥，
 * 5 路并发下载不再占用主线程。进度经 downloadProgress 事件按 taskId 过滤后透传
 * （小 JSON，不构成桥接压力），节流由调用方处理（沿用 runTask 的 400ms patchTask 节流）。
 *
 * 中断走 nativeCancelDownload（保留 .part 供续传）；同 destPath 再次调用即断点续传。
 * 插件/方法缺失（老 App 包）时 promise 拒绝，由调用方回退分块过桥路径。
 */
export function nativeDownloadFile(
    taskId: string,
    url: string,
    headers: Record<string, string>,
    destPath: string,
    onProgress?: (loaded: number, total: number) => void,
): Promise<INativeDownloadResult> {
    return new Promise<INativeDownloadResult>((resolve, reject) => {
        let settled = false;
        // 事件监听先于请求注册：进度在 resolve/reject 后不再透传，并随调用结束解绑
        const removeListener = addNativeListener(
            downloadPluginName(),
            "downloadProgress",
            (data: any) => {
                if (settled || !data || data.taskId !== taskId) {
                    return;
                }
                onProgress?.(Number(data.loaded) || 0, Number(data.total) || 0);
            },
        );
        const settle = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            removeListener();
            fn();
        };
        callNativeMethod(downloadPluginName(), "downloadFile", { taskId, url, headers, destPath })
            .then((res: any) => {
                settle(() =>
                    resolve({
                        path: String(res?.path ?? destPath),
                        size: Number(res?.size) || 0,
                        contentType: res?.contentType ? String(res.contentType) : undefined,
                    }),
                );
            })
            .catch((e: any) => {
                settle(() => reject(e));
            });
    });
}

/** 中断原生直落磁盘下载（保留 .part 供续传）；任务不存在 / 插件缺失均视为成功（幂等） */
export async function nativeCancelDownload(taskId: string): Promise<void> {
    try {
        await callNativeMethod(downloadPluginName(), "cancelDownload", { taskId });
    } catch {
        // 幂等：任务已结束或插件缺失时忽略
    }
}

