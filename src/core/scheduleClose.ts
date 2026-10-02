import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { TrackPlayerSingleton, TrackPlayerEvents } from "./trackPlayer";

/**
 * 定时关闭（参考 MusicFree 移动端 utils/scheduleClose.ts）
 *
 * - deadline：到点时间戳，null 表示未开启；
 * - closeAfterPlayEnd：到点时若正在播，等当前这首歌播完再关闭；
 * - 与原版的差异：原版到点是 reset 播放器并退出应用，混合架构里
 *   关闭即暂停播放（保留播放进度），系统媒体通知随暂停态收起。
 */

const deadlineAtom = atom<number | null>(null);
const closeAfterPlayEndAtom = atom(false);

let timerId: ReturnType<typeof setTimeout> | null = null;

/** 到点回调统一走这里：开着「播完再关」就挂 PlayEnd，否则立即暂停 */
function onScheduleCloseReached() {
    const store = getDefaultStore();
    if (store.get(closeAfterPlayEndAtom)) {
        // off 再 on，避免连续设置多个倒计时时重复注册
        TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
        TrackPlayerSingleton.on(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
    } else {
        finishScheduleClose();
    }
}

/** 当前这首歌播完 → 关闭并清掉监听 */
function pauseOnPlayEnd() {
    finishScheduleClose();
}

/** 关闭播放并复位定时状态 */
function finishScheduleClose() {
    TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
    void TrackPlayerSingleton.pause();
    getDefaultStore().set(deadlineAtom, null);
}

export function setScheduleClose(deadline: number | null) {
    getDefaultStore().set(deadlineAtom, deadline);
    if (timerId) {
        clearTimeout(timerId);
        timerId = null;
    }
    if (deadline && deadline > Date.now()) {
        timerId = setTimeout(onScheduleCloseReached, deadline - Date.now());
    } else if (deadline !== null) {
        // 传了个已过期的时间戳，视同取消
        finishScheduleClose();
    }
}

export function setCloseAfterPlayEnd(closeAfterPlayEnd: boolean) {
    if (!closeAfterPlayEnd) {
        // 边界条件：倒计时已到点、TrackPlayer 停止前取消了勾选
        TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, pauseOnPlayEnd);
    }
    getDefaultStore().set(closeAfterPlayEndAtom, closeAfterPlayEnd);
}

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
