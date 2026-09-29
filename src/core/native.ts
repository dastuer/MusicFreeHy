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

/** 主线程原生 HTTP 请求（仅在 hasNativeHttp() 时调用） */
export async function nativeHttpRequest(options: {
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
