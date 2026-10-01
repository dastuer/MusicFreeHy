/** 渲染层与插件宿主的桥（对齐桌面端 src/core/ipc.ts 的对外 API） */

import { pluginHost } from "./pluginHost";
import type { SerializedPlugin } from "./pluginHost";

export { pluginHost };
export type { SerializedPlugin };

export async function pluginCall<T = any>(
    hash: string,
    method: string,
    ...args: any[]
): Promise<T> {
    return pluginHost.callMethod<T>(hash, method, ...args);
}

let cachedPlugins: SerializedPlugin[] = [];

/** 插件集合变化订阅：常驻组件（音源设置面板等）据此在安装/卸载/启停后重新拉取 */
const pluginsChangedListeners = new Set<() => void>();
let pluginsVersion = 0;

/** 插件集合版本号：随 invalidatePluginCache 自增，供 useSyncExternalStore 使用 */
export function getPluginsVersion(): number {
    return pluginsVersion;
}

export function subscribePluginsChanged(cb: () => void): () => void {
    pluginsChangedListeners.add(cb);
    return () => {
        pluginsChangedListeners.delete(cb);
    };
}

function notifyPluginsChanged() {
    pluginsChangedListeners.forEach((l) => l());
}

export async function getPlugins(refresh = false): Promise<SerializedPlugin[]> {
    await pluginHost.setup().catch((e) => {
        // 初始化失败不让页面卡死：降级为空列表，具体调用插件方法时再报错
        console.warn("[ipc] 插件宿主初始化失败", e);
    });
    if (refresh || !cachedPlugins.length) {
        cachedPlugins = pluginHost.getSerializedPlugins();
        // 用户设置的默认音源置顶（影响搜索默认选择与发现页/排行榜的尝试顺序）
        const defaultHash = localStorage.getItem("defaultPluginHash");
        if (defaultHash) {
            cachedPlugins = [
                ...cachedPlugins.filter(
                    (p) => p.hash === defaultHash && p.enabled && p.state === "Mounted",
                ),
                ...cachedPlugins.filter(
                    (p) => p.hash !== defaultHash || !(p.enabled && p.state === "Mounted"),
                ),
            ];
        }
    }
    return cachedPlugins;
}

export function invalidatePluginCache() {
    cachedPlugins = [];
    // 插件集合可能已变：广播给订阅方（音源设置面板等常驻组件）重新拉取
    pluginsVersion += 1;
    notifyPluginsChanged();
}

export async function getPluginByMedia(
    mediaItem?: { platform: string } | null,
): Promise<SerializedPlugin | undefined> {
    if (!mediaItem?.platform) {
        return undefined;
    }
    const plugins = await getPlugins();
    return plugins.find(
        (p) => p.enabled && p.state === "Mounted" && p.platform === mediaItem.platform,
    );
}

export async function getSortedPluginsWithAbility(
    ability: string,
): Promise<SerializedPlugin[]> {
    const plugins = await getPlugins();
    return plugins.filter(
        (p) => p.enabled && p.state === "Mounted" && p.supportedMethods.includes(ability),
    );
}

export async function getSortedSearchablePlugins(): Promise<SerializedPlugin[]> {
    return getSortedPluginsWithAbility("search");
}

/** ---------- base64url 工具 ---------- */

export function b64urlEncode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): string {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
