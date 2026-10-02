import { useState } from "react";
import { useAtomValue } from "jotai";
import {
    closeSleepTimer,
    sleepTimerOpenAtom,
    openPrompt,
    showToast,
} from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";
import { IconCheck } from "./Icons";
import {
    formatCountdown,
    setCloseAfterPlayEnd,
    setScheduleClose,
    useCloseAfterPlayEnd,
    useScheduleCloseCountDown,
} from "@/core/scheduleClose";

/** 快捷分钟数，与原版 MusicFree 一致 */
const SHORTCUT_MINUTES = [10, 20, 30, 45, 60];

/**
 * 定时关闭底部面板：时长选项单独成行，点选仅标记、
 * 按「开始定时」才生效；倒计时中可「取消定时」（浅色 ghost 按钮）。
 */
export default function SleepTimerSheet() {
    const open = useAtomValue(sleepTimerOpenAtom);

    // 系统返回先收起面板
    useBackLayer(open, "sleep-timer", closeSleepTimer);

    if (!open) {
        return null;
    }

    return (
        <div className="sheet-mask" onClick={() => closeSleepTimer()}>
            <div className="sleep-timer-panel" onClick={(e) => e.stopPropagation()}>
                <SleepTimerBody />
            </div>
        </div>
    );
}

function SleepTimerBody() {
    const countDown = useScheduleCloseCountDown();
    const closeAfterPlay = useCloseAfterPlayEnd();
    const counting = countDown !== null;
    // 待确认的分钟数：点行只改选中，按「开始定时」才真正开始倒计时
    const [selected, setSelected] = useState<number | null>(null);
    const isCustom = selected !== null && !SHORTCUT_MINUTES.includes(selected);

    const pickCustomMinutes = (raw: string) => {
        const minutes = Number(raw);
        if (!Number.isFinite(minutes) || minutes <= 0 || !minutes) {
            showToast("请输入有效的分钟数");
            return;
        }
        setSelected(Math.round(minutes));
    };

    const confirm = () => {
        if (!selected) {
            showToast("请先选择时长");
            return;
        }
        setScheduleClose(Date.now() + selected * 60000);
        closeSleepTimer();
    };

    // 预计关闭时间：倒计时中按剩余时间算，否则按待确认的选中项算
    const eta = counting
        ? formatClock(Date.now() + countDown * 1000)
        : selected
          ? formatClock(Date.now() + selected * 60000)
          : null;

    return (
        <>
            <div className="sleep-timer-header">
                <span>
                    {counting
                        ? `关闭倒计时 ${formatCountdown(countDown)}`
                        : "定时关闭"}
                </span>
                {eta && (
                    <span className="sleep-timer-eta">预计 {eta} 关闭</span>
                )}
            </div>
            <div className="sleep-timer-list">
                {SHORTCUT_MINUTES.map((m) => (
                    <div
                        key={m}
                        className="sleep-timer-row"
                        onClick={() => setSelected(m)}
                    >
                        <div className="sleep-timer-row-title">{m}分钟</div>
                        <span
                            className={`sleep-timer-radio${selected === m ? " on" : ""}`}
                        >
                            {selected === m && <IconCheck size={12} />}
                        </span>
                    </div>
                ))}
                <div
                    className="sleep-timer-row"
                    onClick={() =>
                        openPrompt({
                            title: "自定义时间（分钟）",
                            placeholder: "例如 90",
                            onConfirm: pickCustomMinutes,
                        })
                    }
                >
                    <div className="sleep-timer-row-title">
                        自定义
                        {isCustom && (
                            <span className="sleep-timer-row-value">{selected}分钟</span>
                        )}
                    </div>
                    <span className={`sleep-timer-radio${isCustom ? " on" : ""}`}>
                        {isCustom && <IconCheck size={12} />}
                    </span>
                </div>
            </div>
            <div
                className="sleep-timer-after-play"
                onClick={() => setCloseAfterPlayEnd(!closeAfterPlay)}
            >
                <span className={`sleep-timer-check${closeAfterPlay ? " on" : ""}`}>
                    ✓
                </span>
                播放完歌曲再关闭
            </div>
            <div className="sleep-timer-actions">
                {counting && (
                    <button className="pill" onClick={() => setScheduleClose(null)}>
                        取消定时
                    </button>
                )}
                <button className="pill primary" onClick={confirm}>
                    开始定时
                </button>
            </div>
        </>
    );
}

/** 预计关闭时刻：HH:mm（24 小时制） */
function formatClock(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
