import { useAtomValue, useSetAtom } from "jotai";
import {
    TrackPlayerSingleton,
    usePlayList,
    useCurrentMusic,
    useRepeatMode,
    useMusicState,
} from "@/core/trackPlayer";
import { queueOpenAtom } from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";
import {
    IconRepeatOff,
    IconRepeatQueue,
    IconRepeatSingle,
    IconPlaying,
    IconTrash,
    IconClose,
} from "@/components/base/Icons";
import Spinner from "@/components/base/Spinner";

const MODE_LABEL = { off: "顺序播放", queue: "列表循环", single: "单曲循环" } as const;

export default function PlayQueuePanel() {
    const open = useAtomValue(queueOpenAtom);
    const setOpen = useSetAtom(queueOpenAtom);
    const playList = usePlayList();
    const currentMusic = useCurrentMusic();
    const repeatMode = useRepeatMode();
    const musicState = useMusicState();

    // 系统返回先收起抽屉
    useBackLayer(open, "play-queue", () => setOpen(false));

    if (!open) {
        return null;
    }

    const ModeIcon =
        repeatMode === "queue" ? IconRepeatQueue : repeatMode === "single" ? IconRepeatSingle : IconRepeatOff;

    return (
        <>
            <div
                className="dialog-mask"
                style={{ alignItems: "flex-end", zIndex: 65 }}
                onClick={() => setOpen(false)}
            />
            <div className="queue-panel">
                <div className="queue-header">
                    <span className="queue-mode" onClick={() => TrackPlayerSingleton.toggleRepeatMode()}>
                        <ModeIcon size={17} />
                        {MODE_LABEL[repeatMode]}
                    </span>
                    <span className="queue-count">({playList.length})</span>
                    <button
                        className="queue-clear icon-btn"
                        onClick={() => TrackPlayerSingleton.clearPlayListAndStop()}
                    >
                        <IconTrash size={18} />
                    </button>
                    <button className="icon-btn" onClick={() => setOpen(false)}>
                        <IconClose size={20} />
                    </button>
                </div>
                <div className="queue-list">
                    {playList.map((item, idx) => {
                        const isCurrent =
                            currentMusic?.id === item.id && currentMusic?.platform === item.platform;
                        return (
                            <div
                                key={`${item.platform}-${item.id}-${idx}`}
                                className={`queue-row ${isCurrent ? "current" : ""}`}
                                onClick={() => TrackPlayerSingleton.play(item)}
                            >
                                <div className="music-row-index">
                                    {isCurrent && musicState === "loading" ? (
                                        <Spinner size={14} strokeWidth={2.2} />
                                    ) : isCurrent ? (
                                        <IconPlaying size={14} />
                                    ) : (
                                        <span className="row-num">{idx + 1}</span>
                                    )}
                                </div>
                                <div className="queue-row-info">
                                    <div className="queue-row-title">{item.title}</div>
                                    <div className="queue-row-sub">{item.artist}</div>
                                </div>
                                <button
                                    className="icon-btn"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        TrackPlayerSingleton.remove(item);
                                    }}
                                >
                                    <IconTrash size={16} />
                                </button>
                            </div>
                        );
                    })}
                    {!playList.length && (
                        <div className="empty-tip">播放队列是空的</div>
                    )}
                </div>
            </div>
        </>
    );
}
