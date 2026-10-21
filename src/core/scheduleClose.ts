import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import {
    TrackPlayerSingleton,
    TrackPlayerEvents,
    musicStateAtom,
    repeatModeAtom,
} from "./trackPlayer";
import { NativeAudioElement, addSleepTimerListener, setNativeSleepTimer, queryNativeSleepTimer } from "./nativeAudio";

/**
 * 定时关闭（参考 MusicFree 移动端 utils/scheduleClose.ts）
 *
 * - deadline：到点时间戳，null 表示未开启；
 * - closeAfterPlayEnd：到点时若正在播，等当前这首歌播完再关闭；
 * - 与原版的差异：原版到点是 reset 播放器并退出应用，混合架构里
 *   关闭即暂停播放（保留播放进度），系统媒体通知随暂停态收起；
 * - 立即关闭的路径先做 2s 音量淡出再暂停，到点即掐断会显得突兀。
 *
 * ## 倒计时归谁（关键）
 *
 * Android 的播放内核是前台服务里的 ExoPlayer，页面切后台后 WebView 的
 * 定时器会被系统冻结——只靠这里 setTimeout 到点根本不会执行，歌照放，
 * 就是「后台播放时定时关闭不生效」的根因。因此**原生后端可用时倒计时
 * 下沉到原生服务**（PlaybackBridge.setSleepTimer），暂停与淡出都在原生做，
 * 页面冻结/被杀都不影响；页面这边只负责展示与状态同步。
 * 浏览器 / iOS（WebView <audio>）没有原生服务，继续走本地 setTimeout。
 */

const deadlineAtom = atom<number | null>(null);
const closeAfterPlayEndAtom = atom(false);

let timerId: ReturnType<typeof setTimeout> | null = null;
/** 到点淡出的进行中定时器；重新设置 / 取消倒计时时要清掉 */
let fadeTimerId: ReturnType<typeof setInterval> | null = null;

const FADE_DURATION_MS = 2000;
const FADE_TICK_MS = 100;

/** 原生后端（定时关闭下沉，页面冻结也生效）；null = 还没判定过 */
let nativeAudioRef: NativeAudioElement | null = null;
let sleepTimerSubscription: (() => void) | null = null;

/**
 * 当前是否在原生后端上播（定时关闭据此决定下沉还是本地计时）。
 * 后端是异步探测替换的（先是占位 <audio>，几毫秒后换成 ExoPlayer 代理），
 * 这里只在已经是原生代理时才算命中。
 */
function nativeBackend(): NativeAudioElement | null {
    const audio = TrackPlayerSingleton.getAudioBackend();
    if (!(audio instanceof NativeAudioElement)) {
        return null;
    }
    nativeAudioRef = audio;
    if (!sleepTimerSubscription) {
        // 原生到点 / 取消会推 sleeptimer：把页面侧倒计时对齐（页面冻结期间
        // 错过的事件，回前台由 visibilitychange 的同步补上）。
        // 注意这里**不**写「播完再关」的勾选：那是纯用户偏好，原生只在到点后
        // 才知道等不等片尾（到点前恒为 false），回写会把用户的勾选抹掉。
        sleepTimerSubscription = addSleepTimerListener(({ deadline }) => {
            getDefaultStore().set(deadlineAtom, deadline > 0 ? deadline : null);
        });
    }
    return nativeAudioRef;
}

/**
 * 把页面侧已设的倒计时迁到原生（后端刚从占位 <audio> 换成原生代理时调）。
 *
 * 只在冷启动探测竞态下才有意义：`createAudioElement()` 要探一次原生插件，
 * 这几十毫秒里用户若已经设好定时，走的是页面 setTimeout；后端换成原生后
 * 必须把倒计时补交给服务，否则切后台一样会被冻结。
 */
export async function migrateSleepTimerToNative(): Promise<void> {
    if (!nativeBackend()) {
        return;
    }
    const deadline = getDefaultStore().get(deadlineAtom);
    if (!deadline || deadline <= Date.now()) {
        return;
    }
    const ok = await setNativeSleepTimer(
        deadline,
        getDefaultStore().get(closeAfterPlayEndAtom),
    );
    if (ok && timerId) {
        // 原生接过去了：页面计时器作废（留着会在前台多关一次，虽无害但多余）
        clearTimeout(timerId);
        timerId = null;
    }
}

/** 到点回调统一走这里：开着「播完再关」就挂 PlayEnd，否则淡出后暂停 */
function onScheduleCloseReached() {
    const store = getDefaultStore();
    if (store.get(closeAfterPlayEndAtom)) {
        if (store.get(repeatModeAtom) === "single") {
            // 单曲循环下 audio.loop 让歌曲永不 ended，PlayEnd 等不到：到点直接关
            finishScheduleClose();
            return;
        }
        // off 再 on，避免连续设置多个倒计时时重复注册
        TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
        TrackPlayerSingleton.on(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
        return;
    }
    if (store.get(musicStateAtom) === "playing") {
        fadeOutAndPause();
    } else {
        finishScheduleClose();
    }
}

/** 2 秒音量渐弱后暂停并恢复音量；期间用户手动暂停/切歌则立刻恢复音量收场 */
function fadeOutAndPause() {
    cancelFade();
    const player = TrackPlayerSingleton;
    const startVolume = player.getVolume();
    if (startVolume <= 0.01) {
        finishScheduleClose();
        return;
    }
    const startedAt = Date.now();
    fadeTimerId = setInterval(() => {
        const store = getDefaultStore();
        const elapsed = Date.now() - startedAt;
        // 淡出过程中播放被打断（用户暂停 / 换歌 / 播放失败）：恢复音量，不再强行暂停
        if (store.get(musicStateAtom) !== "playing") {
            cancelFade();
            player.setVolume(startVolume);
            store.set(deadlineAtom, null);
            return;
        }
        const t = Math.min(elapsed / FADE_DURATION_MS, 1);
        player.setVolume(startVolume * (1 - t));
        if (t >= 1) {
            cancelFade();
            finishScheduleClose();
            // 暂停后把音量还原，下次播放回到用户设定值
            player.setVolume(startVolume);
        }
    }, FADE_TICK_MS);
}

function cancelFade() {
    if (fadeTimerId) {
        clearInterval(fadeTimerId);
        fadeTimerId = null;
    }
}

/** 当前这首歌播完 → 关闭并清掉监听 */
function pauseOnPlayEnd() {
    finishScheduleClose();
}

/** 关闭播放并复位定时状态 */
function finishScheduleClose() {
    cancelFade();
    TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
    void TrackPlayerSingleton.pause();
    getDefaultStore().set(deadlineAtom, null);
}

export function setScheduleClose(deadline: number | null) {
    const store = getDefaultStore();
    store.set(deadlineAtom, deadline);
    if (timerId) {
        clearTimeout(timerId);
        timerId = null;
    }
    cancelFade();
    const applyLocally = () => {
        if (deadline && deadline > Date.now()) {
            timerId = setTimeout(onScheduleCloseReached, deadline - Date.now());
        } else if (deadline !== null) {
            // 传了个已过期的时间戳，视同取消
            finishScheduleClose();
        }
    };
    if (nativeBackend()) {
        // 原生后端：倒计时与到点收尾全部交给服务（页面冻结也生效），
        // 页面只等 service 的 sleeptimer 事件回写状态。
        const closeAfterTrack = store.get(closeAfterPlayEndAtom);
        const expired = deadline !== null && deadline <= Date.now();
        void setNativeSleepTimer(deadline ?? 0, closeAfterTrack && !!deadline).then(
            (ok) => {
                if (!ok) {
                    // 服务还没就绪（刚冷启动 / 被回收）：退回页面计时兜底，
                    // 下次设置或回前台迁移时再交给原生
                    applyLocally();
                    return;
                }
                if (expired) {
                    store.set(deadlineAtom, null);
                }
            },
        );
        return;
    }
    // 原生探测还没定下来（冷启动的占位 <audio>）：先按页面计时，
    // 后端换成原生代理后由 trackPlayer 调 migrateSleepTimerToNative 补交
    applyLocally();
}

export function setCloseAfterPlayEnd(closeAfterPlayEnd: boolean) {
    const store = getDefaultStore();
    store.set(closeAfterPlayEndAtom, closeAfterPlayEnd);
    if (nativeBackend()) {
        // 用 -1 表示「只改开关，别重置倒计时」：倒计时还没设时也照常下发，
        // 到点自然按最新勾选执行
        void setNativeSleepTimer(-1, closeAfterPlayEnd);
        return;
    }
    if (!closeAfterPlayEnd) {
        // 边界条件：倒计时已到点、TrackPlayer 停止前取消了勾选
        TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
    }
}

/**
 * 从原生服务拉一次定时关闭状态（页面回前台 / 打开定时面板时调用）：
 * 页面冻结期间定时可能已经到点执行，或用户在别处改过。
 */
export async function syncScheduleCloseFromNative() {
    if (!nativeBackend()) {
        return;
    }
    const state = await queryNativeSleepTimer();
    if (!state) {
        return;
    }
    const store = getDefaultStore();
    store.set(deadlineAtom, state.deadline > 0 ? state.deadline : null);
    // 原生正在等当前曲播完：说明用户开着「播完再关」，勾选状态跟着对齐
    // （到点前原生恒为 false，这时不能反写，否则会把用户的勾选抹掉）
    if (state.closeAfterTrack) {
        store.set(closeAfterPlayEndAtom, true);
    }
}

// 回前台对一次账：冻结期间原生可能已经执行完定时（页面的 sleeptimer 事件
// 在冻结时收不到），倒计时/状态得跟原生对齐。用 visibilitychange 而不是
// 挂进 trackPlayer 的对账流程，免得 scheduleClose ↔ trackPlayer 循环依赖。
if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void migrateSleepTimerToNative();
            void syncScheduleCloseFromNative();
        }
    });
}

// 原生后端探测完成：冷启动窗口里按页面计时设下的定时补交给原生服务
// （trackPlayer 用事件通知，避免直接 import 造成循环依赖）
TrackPlayerSingleton.on(TrackPlayerEvents.NativeBackendReady, () => {
    void migrateSleepTimerToNative();
});

/** 剩余秒数，未开启时为 null，每秒跳动 */
export function useScheduleCloseCountDown(): number | null {
    const deadline = useAtomValue(deadlineAtom);

    const [countDown, setCountDown] = useState<number | null>(
        deadline ? deadline - Date.now() : null,
    );

    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        intervalRef.current && clearInterval(intervalRef.current);
        intervalRef.current = null;

        if (!deadline || deadline <= Date.now()) {
            setCountDown(null);
            return;
        }
        setCountDown(Math.max(deadline - Date.now(), 0) / 1000);
        intervalRef.current = setInterval(() => {
            setCountDown(Math.max(deadline - Date.now(), 0) / 1000);
        }, 1000);

        return () => {
            intervalRef.current && clearInterval(intervalRef.current);
            intervalRef.current = null;
        };
    }, [deadline]);

    return countDown;
}

export const useCloseAfterPlayEnd = () => useAtomValue(closeAfterPlayEndAtom);

/** 倒计时展示：mm:ss，超过一小时 h:mm:ss（与原版 timeformat 一致） */
export function formatCountdown(time: number): string {
    time = Math.round(time);
    if (time < 60) {
        return `00:${time.toFixed(0).padStart(2, "0")}`;
    }
    const sec = Math.floor(time % 60);
    time = Math.floor(time / 60);
    const min = time % 60;
    time = Math.floor(time / 60);
    const formatted = `${min.toString().padStart(2, "0")}:${sec
        .toFixed(0)
        .padStart(2, "0")}`;
    if (time === 0) {
        return formatted;
    }
    return `${time}:${formatted}`;
}
