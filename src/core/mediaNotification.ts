/**
 * 系统媒体通知（Android 下拉通知栏的媒体卡片）
 *
 * Android WebView 不认 Web MediaSession，系统下拉栏里出不来网易云那种
 * 「封面 + 歌名 + 上/下一首」的播放通知。这里在原生环境把播放状态经
 * MediaNotificationPlugin 推给原生（MediaPlaybackService 挂 MediaStyle 通知），
 * 通知按钮 / 耳机线控的动作再以事件回传，转调 TrackPlayer。
 *
 * 状态推送是单向尽力而为：通知显示失败（如未授予通知权限）不影响播放本身。
 * 进度条不需要逐帧同步 —— Android 会按「上报位置 + 倍速」自行外推，这里只
 * 每秒对一次表，纠正缓冲卡顿造成的漂移。
 */

import { getDefaultStore } from "jotai";
import { addNativeListener, callNativeMethod, isNative } from "./native";
import {
    currentMusicAtom,
    musicStateAtom,
    progressAtom,
    rateAtom,
    TrackPlayerSingleton,
} from "./trackPlayer";
import type { MusicState } from "./trackPlayer";

const PLUGIN = "MediaNotification";

let started = false;
let permissionChecked = false;
/** 播放中的秒级对表定时器 */
let syncTimer: ReturnType<typeof setInterval> | null = null;

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

function currentSnapshot() {
    const store = getDefaultStore();
    const music = store.get(currentMusicAtom);
    const progress = store.get(progressAtom);
    return {
        music,
        position: progress.position || 0,
        // 有些音源给的 music.duration 元数据不准，音频元素解析出的真实时长优先
        duration: progress.duration || music?.duration || 0,
        rate: store.get(rateAtom) || 1,
    };
}

function pushPlayback(state: MusicState) {
    const { music, position, duration, rate } = currentSnapshot();
    if (!music) {
        return;
    }
    callNative("updatePlayback", {
        playing: state === "playing",
        position,
        rate,
        duration,
    });
}

function stopPositionSync() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
}

function startPositionSync() {
    if (syncTimer) {
        return;
    }
    syncTimer = setInterval(() => {
        if (getDefaultStore().get(musicStateAtom) !== "playing") {
            stopPositionSync();
            return;
        }
        pushPlayback("playing");
    }, 1000);
}

/**
 * 挂接播放器 ↔ 原生通知（仅 Android 原生环境，App 启动时调用一次）。
 */
export function setupMediaNotification() {
    if (started || !onAndroid()) {
        return;
    }
    started = true;
    const store = getDefaultStore();

    // 换歌 → 推元数据；清空队列 → 收通知
    store.sub(currentMusicAtom, () => {
        const music = store.get(currentMusicAtom);
        if (!music) {
            stopPositionSync();
            callNative("stop");
            return;
        }
        let artwork = typeof music.artwork === "string" ? music.artwork : "";
        if (artwork.length > 64 * 1024) {
            artwork = ""; // 超大内联封面不进通知（原生兜底用应用图标）
        }
        callNative("updateMetadata", {
            title: music.title ?? "",
            artist: music.artist ?? "",
            album: music.album ?? "",
            artwork,
            duration: music.duration || 0,
        });
    });

    // 播放状态变化 → 推播放状态；停止 → 收通知
    store.sub(musicStateAtom, () => {
        const state = store.get(musicStateAtom);
        if (!store.get(currentMusicAtom)) {
            return;
        }
        if (state === "stopped") {
            stopPositionSync();
            callNative("stop");
            return;
        }
        if (state === "playing") {
            ensurePermissionOnce();
            startPositionSync();
        } else {
            stopPositionSync();
        }
        pushPlayback(state);
    });

    // 原生控制动作回传（通知按钮 / 耳机线控 / 蓝牙）
    addNativeListener(PLUGIN, "action", (data: any) => {
        const action = data?.action as string | undefined;
        switch (action) {
            case "play":
            case "toggle":
                TrackPlayerSingleton.togglePlay();
                break;
            case "pause":
                TrackPlayerSingleton.pause();
                break;
            case "previous":
                TrackPlayerSingleton.skipToPrevious();
                break;
            case "next":
                TrackPlayerSingleton.skipToNext();
                break;
            case "seek":
                if (typeof data.position === "number" && Number.isFinite(data.position)) {
                    TrackPlayerSingleton.seekTo(data.position);
                }
                break;
            case "close":
                // 划掉通知视为停止播放（与网易云一致）；歌单保留，回 App 可重新播
                TrackPlayerSingleton.pause();
                break;
            default:
                break;
        }
    });
}
