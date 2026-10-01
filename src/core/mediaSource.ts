import { useEffect, useState, useSyncExternalStore } from "react";
import { getPlugins, subscribePluginsChanged, getPluginsVersion, type SerializedPlugin } from "./ipc";

/**
 * 全局音源：整个 App 只有一份音源状态，所有页面（发现/搜索/排行榜/歌单/专辑/歌手）共用。
 *  - 手动切换的音源持久化到 localStorage（globalSourceHash），下次启动仍使用该音源；
 *  - 未手动选择过（AUTO）时跟随「默认音源」（插件管理页设置，defaultPluginHash），默认音源不可用再逐个降级；
 *  - 手动指定的音源被卸载/禁用时自动回到默认音源；
 *  - 插件管理页重新设置默认音源时，全局音源同步切回默认音源。
 */

export const AUTO_SOURCE = "auto";

const DEFAULT_PLUGIN_KEY = "defaultPluginHash";
const GLOBAL_SOURCE_KEY = "globalSourceHash";

/** 旧版按页面记忆音源（pageSource.*），统一为全局音源后清掉遗留键 */
(function cleanupLegacyPageSource() {
    try {
        const stale: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key?.startsWith("pageSource.")) {
                stale.push(key);
            }
        }
        stale.forEach((key) => localStorage.removeItem(key));
    } catch {
        // localStorage 不可用时忽略
    }
})();

/** 启动时恢复上次手动选择的音源；没选过或存储异常则回到 AUTO（跟随默认音源） */
function loadPersistedSource(): string {
    try {
        const saved = localStorage.getItem(GLOBAL_SOURCE_KEY);
        return saved && saved !== AUTO_SOURCE ? saved : AUTO_SOURCE;
    } catch {
        return AUTO_SOURCE;
    }
}

let sessionSource = loadPersistedSource();
const listeners = new Set<() => void>();
const defaultListeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

function emitDefault() {
    defaultListeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

function subscribeDefault(cb: () => void) {
    defaultListeners.add(cb);
    return () => {
        defaultListeners.delete(cb);
    };
}

/** 当前全局音源：手动切换过则为该插件 hash，否则 AUTO（跟随默认音源） */
export function getGlobalSource(): string {
    return sessionSource;
}

/** 手动切换全局音源并持久化；传空/AUTO 表示回到默认音源 */
export function setGlobalSource(hash: string) {
    const next = !hash || hash === AUTO_SOURCE ? AUTO_SOURCE : hash;
    if (next === sessionSource) {
        return;
    }
    sessionSource = next;
    try {
        if (next === AUTO_SOURCE) {
            localStorage.removeItem(GLOBAL_SOURCE_KEY);
        } else {
            localStorage.setItem(GLOBAL_SOURCE_KEY, next);
        }
    } catch {
        // localStorage 不可用时仅本会话生效
    }
    emit();
}

/** 全局音源被绕过本模块直接写入 localStorage（如备份恢复）后调用，同步会话状态并通知订阅组件 */
export function notifyGlobalSourceChanged() {
    sessionSource = loadPersistedSource();
    emit();
}

/** React 绑定：所有页面/切换器订阅同一份全局状态，一处切换处处生效 */
export function useGlobalSource(): string {
    return useSyncExternalStore(subscribe, getGlobalSource);
}

/** 默认音源（插件管理页 / 我的页音源面板维护；localStorage 为事实来源） */
export function getDefaultPluginHash(): string | null {
    try {
        return localStorage.getItem(DEFAULT_PLUGIN_KEY);
    } catch {
        return null;
    }
}

/** 设置/取消默认音源；设置后全局音源立即切回默认音源 */
export function setDefaultPluginHash(hash: string | null) {
    if (hash) {
        localStorage.setItem(DEFAULT_PLUGIN_KEY, hash);
    } else {
        localStorage.removeItem(DEFAULT_PLUGIN_KEY);
    }
    emitDefault();
    setGlobalSource(AUTO_SOURCE);
}

/** 默认音源被绕过本模块直接写入（如备份恢复）后调用，通知订阅组件刷新 */
export function notifyDefaultPluginHashChanged() {
    emitDefault();
}

/** React 绑定：默认音源变化时订阅组件自动刷新 */
export function useDefaultPluginHash(): string | null {
    return useSyncExternalStore(subscribeDefault, getDefaultPluginHash);
}

/** 插件集合版本号：安装/卸载/启停/恢复备份后自增；keep-alive 页面据此重新拉取插件列表 */
export function usePluginsVersion(): number {
    return useSyncExternalStore(subscribePluginsChanged, getPluginsVersion);
}

/**
 * 已启用且挂载成功的音源插件列表；「我的 → 音源设置」面板与我的页角标共用。
 * 顺带做失效自愈：手动指定的音源被卸载/禁用时，自动回到默认音源。
 * 插件安装/卸载/启停/恢复备份后（ipc 层广播）自动重新拉取，新装的音源无需重启即可见。
 */
export function useUsablePlugins(): SerializedPlugin[] {
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    useEffect(() => {
        let cancelled = false;
        const load = () => {
            getPlugins().then((list) => {
                if (cancelled) {
                    return;
                }
                const usable = list.filter((p) => p.enabled && p.state === "Mounted");
                setPlugins(usable);
                const cur = getGlobalSource();
                if (cur !== AUTO_SOURCE && usable.length && !usable.some((p) => p.hash === cur)) {
                    setGlobalSource(AUTO_SOURCE);
                }
            });
        };
        load();
        const unsubscribe = subscribePluginsChanged(load);
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);
    return plugins;
}

/** 音源显示名：跟随默认音源时显示默认插件名，手动指定时显示插件名 */
export function getSourceDisplayName(
    plugins: SerializedPlugin[],
    hash: string,
    defaultHash: string | null = getDefaultPluginHash(),
): string {
    if (!hash || hash === AUTO_SOURCE) {
        return (defaultHash && plugins.find((p) => p.hash === defaultHash)?.name) || "自动";
    }
    return plugins.find((p) => p.hash === hash)?.name ?? "自动";
}

/**
 * 按插件方法筛选：手动指定音源时只返回该插件，返回空数组即「当前音源不可用」。
 * 跟随默认音源（AUTO）时返回全部支持该方法的插件（默认音源已排最前，失败自动降级）。
 * 手动指定的音源被卸载/禁用时退回自动，避免整页不可用。
 */
export function pickSourcePlugins(
    plugins: SerializedPlugin[],
    method: string,
    sourceHash: string,
): SerializedPlugin[] {
    const capable = plugins.filter((p) => p.supportedMethods.includes(method));
    if (!sourceHash || sourceHash === AUTO_SOURCE) {
        return capable;
    }
    const pinned = capable.filter((p) => p.hash === sourceHash);
    return pinned.length ? pinned : capable;
}
