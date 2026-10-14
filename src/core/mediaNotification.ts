/**
 * 媒体通知权限与后台保活引导（瘦身版）。
 *
 * 播放内核重构后，下拉通知栏的媒体卡片由 Media3 MediaSessionService 直接
 * 从播放队列渲染（元数据随 pushQueueWindow/loadTrack 携带），通知按钮、
 * 耳机线控、蓝牙按键也由 Media3 直达播放器——本模块不再承担状态推送与
 * 动作转发，只保留两件事：
 *  1. Android 13+ 的通知权限申请（通知卡片显示的前提）；
 *  2. 电池优化白名单的查询 / 请求 / 首播引导（Doze 限网是熄屏断流的根因）。
 */

import { getDefaultStore } from "jotai";
import { callNativeMethod, isNative } from "./native";
import { musicStateAtom } from "./trackPlayer";

const PLUGIN = "PlaybackBridge";

let started = false;
let permissionChecked = false;

function onAndroid(): boolean {
    if (!isNative()) {
        return false;
    }
    try {
        return (window as any).Capacitor?.getPlatform?.() === "android";
    } catch {
        return false;
    }
}

/** Android 原生环境（设置页的保活入口只在安卓上显示） */
export function isAndroidNative(): boolean {
    return onAndroid();
}

function callNative(method: string, options?: Record<string, any>): Promise<any> {
    return callNativeMethod(PLUGIN, method, options ?? {}).catch((e: any) => {
        console.warn(`[mediaNotification] ${method} 失败`, e?.message ?? e);
        return undefined;
    });
}

/** Android 13+ 首次播放前请求一次通知权限；拒绝也照播，只是不显示通知 */
function ensurePermissionOnce() {
    if (permissionChecked) {
        return;
    }
    permissionChecked = true;
    callNative("ensurePermission").then((res: any) => {
        if (res?.granted === false) {
            console.warn("[mediaNotification] 通知权限未授予，下拉栏不显示播放通知");
        }
    });
}

/** 是否已加入电池优化白名单（非安卓原生环境返回 undefined） */
export async function isBatteryOptimizationIgnored(): Promise<boolean | undefined> {
    if (!onAndroid()) {
        return undefined;
    }
    const res = await callNative("isBatteryOptimizationIgnored");
    return res?.ignored;
}

/** 弹系统对话框请求加入电池优化白名单；成功与否由用户在对话框里决定 */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
    if (!onAndroid()) {
        return;
    }
    // 只要弹过一次就不再自动打扰（设置页手动点不在此列）
    localStorage.setItem("batteryKeepAlivePrompted", "1");
    await callNative("requestIgnoreBatteryOptimizations");
}

/** 首次开播时引导一次电池优化白名单（Doze 限网是熄屏断流的根因，拒绝后不再弹） */
function maybePromptBatteryKeepAlive() {
    if (localStorage.getItem("batteryKeepAlivePrompted")) {
        return;
    }
    localStorage.setItem("batteryKeepAlivePrompted", "1");
    isBatteryOptimizationIgnored().then((ignored) => {
        if (ignored === false) {
            callNative("requestIgnoreBatteryOptimizations");
        }
    });
}

/**
 * 挂接权限申请与保活引导（仅 Android 原生环境，App 启动时调用一次）。
 */
export function setupMediaNotification() {
    if (started || !onAndroid()) {
        return;
    }
    started = true;
    const store = getDefaultStore();
    store.sub(musicStateAtom, () => {
        if (store.get(musicStateAtom) === "playing") {
            ensurePermissionOnce();
            maybePromptBatteryKeepAlive();
        }
    });
}
