/**
 * 原生插件运行时（QuickJS）同步 —— L4 的 JS 侧
 *
 * WebView 里的 Worker 沙箱只在页面活着时可用；L4 之后后台解析由 MediaPlaybackService
 * 直连原生 QuickJS 引擎，所以插件源码必须随集合变化推给原生（原生会落盘，
 * 冷启动 / WebView 被杀之后它自己就能恢复）。
 *
 * 顺序与 getPlugins() 一致（含默认音源置顶），原生按数组顺序尝试 getMediaSource。
 */
import { callNativeMethod, isNative } from "./native";
import { pluginHost, setNativeSyncHook } from "./pluginHost";

const PLUGIN = "PluginRuntime";

let initialized = false;
let available = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let rerun = false;

/**原生运行时是否可用（探测过 PluginRuntime.isAvailable 且 available=true） */
export function isNativePluginRuntimeAvailable(): boolean {
    return available;
}

/**App 启动时调用：注册插件集合变化钩子 + 触发首次同步（非原生环境 no-op） */
export function initNativePluginRuntime() {
    if (!isNative() || initialized) {
        return;
    }
    initialized = true;
    setNativeSyncHook(() => scheduleSyncPluginsToNative());
    scheduleSyncPluginsToNative(0);
}

/**插件集合可能变了：去抖调度一次同步（安装/卸载/启停/变量/默认音源变更都会走到） */
export function scheduleSyncPluginsToNative(delay = 800) {
    if (!isNative()) {
        return;
    }
    if (syncTimer !== null) {
        clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
        syncTimer = null;
        void syncPluginsToNative();
    }, delay);
}

/**立即同步一次；已有在跑的就排队再跑一轮（避免并发重复推源码） */
export function syncPluginsToNative(): Promise<void> {
    if (!isNative()) {
        return Promise.resolve();
    }
    if (running) {
        rerun = true;
        return running;
    }
    running = (async () => {
        try {
            const probe = await callNativeMethod(PLUGIN, "isAvailable", {});
            available = !!probe?.available;
            if (!available) {
                console.warn("[nativePluginRuntime] 原生运行时不可用", probe);
                return;
            }
            const plugins = await pluginHost.getNativeSyncSnapshot();
            await callNativeMethod(PLUGIN, "syncPlugins", { plugins });
            console.info(
                `[nativePluginRuntime] 已同步 ${plugins.length} 个插件到原生引擎` +
                    `（ready=${probe.ready}）`,
            );
        } catch (e) {
            console.warn("[nativePluginRuntime] 同步到原生失败", e);
        } finally {
            const again = rerun;
            rerun = false;
            running = null;
            if (again) {
                void syncPluginsToNative();
            }
        }
    })();
    return running;
}
