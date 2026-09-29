import { SerializedPlugin, pluginCall } from "./ipc";

/**
 * 插件方法尝试工具（与桌面端同构）：
 *  - 插件列表已按「默认音源优先」排序（见 ipc.getPlugins）
 *  - 依次尝试，任一成功即返回（附带来源插件名），整体限时
 */
export async function tryPluginMethod<T = any>(
    plugins: SerializedPlugin[],
    method: string,
    args: any[] = [],
    timeoutMs = 12000,
): Promise<{ data: T; pluginName: string } | null> {
    for (const plugin of plugins) {
        try {
            const data = await Promise.race([
                pluginCall(plugin.hash, method, ...args),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("插件响应超时")), timeoutMs),
                ),
            ]);
            return { data: data as T, pluginName: plugin.name };
        } catch (e) {
            console.warn(`[plugin] ${method} via ${plugin.name} failed:`, (e as any)?.message);
            continue;
        }
    }
    return null;
}
