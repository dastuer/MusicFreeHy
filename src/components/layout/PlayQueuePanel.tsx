import { useEffect, useRef, useState } from "react";
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
import { useListSearch } from "@/hooks/useListSearch";
import {
    IconRepeatOff,
    IconRepeatQueue,
    IconRepeatSingle,
    IconPlaying,
    IconTrash,
    IconClose,
    IconSearch,
    IconMenu,
} from "@/components/base/Icons";
import Spinner from "@/components/base/Spinner";

const MODE_LABEL = { off: "顺序播放", queue: "列表循环", single: "单曲循环" } as const;

interface IDragState {
    from: number;
    target: number;
    /** 拖拽行跟手的位移（含列表自动滚动补偿） */
    dy: number;
    rowH: number;
}

/** 拖拽中不进 React 状态的原始量（rAF/高频 move 里读写） */
interface IDragRaw {
    from: number;
    startY: number;
    startScrollTop: number;
    lastClientY: number;
    rowH: number;
}

export default function PlayQueuePanel() {
    const open = useAtomValue(queueOpenAtom);
    const setOpen = useSetAtom(queueOpenAtom);
    const playList = usePlayList();
    const currentMusic = useCurrentMusic();
    const repeatMode = useRepeatMode();
    const musicState = useMusicState();
    const search = useListSearch(playList);
    const [searchOpen, setSearchOpen] = useState(false);
    const [drag, setDrag] = useState<IDragState | null>(null);
    const dragRawRef = useRef<IDragRaw | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    // 系统返回先收起抽屉
    useBackLayer(open, "play-queue", () => setOpen(false));

    // 收起面板时把搜索与拖拽状态一并复位，下次打开是干净的完整列表
    useEffect(() => {
        if (!open) {
            setSearchOpen(false);
            search.close();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    if (!open) {
        return null;
    }

    const ModeIcon =
        repeatMode === "queue" ? IconRepeatQueue : repeatMode === "single" ? IconRepeatSingle : IconRepeatOff;

    // 搜索生效时只过滤展示，原始顺序不动；拖拽只在未过滤的真实顺序下开放
    const viewList = search.active ? search.filtered : playList;

    /** 由指针位置算落点行号：内容坐标 / 行高，向上插到目标行前、向下插到目标行后恰好同值 */
    const calcTarget = (raw: IDragRaw) => {
        const listEl = listRef.current;
        const len = playList.length;
        if (!listEl || !len) {
            return raw.from;
        }
        const rect = listEl.getBoundingClientRect();
        const contentY = raw.lastClientY - rect.top + listEl.scrollTop;
        return Math.min(Math.max(Math.floor(contentY / raw.rowH), 0), len - 1);
    };

    const syncDragVisual = (raw: IDragRaw) => {
        const listEl = listRef.current;
        const scrollDelta = listEl ? listEl.scrollTop - raw.startScrollTop : 0;
        setDrag({
            from: raw.from,
            target: calcTarget(raw),
            dy: raw.lastClientY - raw.startY + scrollDelta,
            rowH: raw.rowH,
        });
    };

    const onDragStart = (e: React.PointerEvent, index: number) => {
        if (search.active) {
            return;
        }
        const row = (e.currentTarget as HTMLElement).closest(".queue-row") as HTMLElement | null;
        if (!row) {
            return;
        }
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const raw: IDragRaw = {
            from: index,
            startY: e.clientY,
            startScrollTop: listRef.current?.scrollTop ?? 0,
            lastClientY: e.clientY,
            rowH: row.getBoundingClientRect().height,
        };
        dragRawRef.current = raw;
        syncDragVisual(raw);
    };

    const onDragMove = (e: React.PointerEvent) => {
        const raw = dragRawRef.current;
        if (!raw) {
            return;
        }
        raw.lastClientY = e.clientY;
        // 拖到列表上下边缘时顺手滚动（跟手滚动，无 rAF 循环，长队列中途停留不滚）
        const listEl = listRef.current;
        if (listEl) {
            const rect = listEl.getBoundingClientRect();
            if (e.clientY < rect.top + 48) {
                listEl.scrollTop -= 10;
            } else if (e.clientY > rect.bottom - 48) {
                listEl.scrollTop += 10;
            }
        }
        syncDragVisual(raw);
    };

    const onDragEnd = () => {
        const raw = dragRawRef.current;
        dragRawRef.current = null;
        if (raw && drag && drag.target !== drag.from) {
            TrackPlayerSingleton.reorderMusic(raw.from, drag.target);
        }
        setDrag(null);
    };

    /** 渲染行内位移：拖拽行跟手，途经的行整体让位滑开 */
    const rowShiftStyle = (idx: number): React.CSSProperties | undefined => {
        if (!drag) {
            return undefined;
        }
        if (idx === drag.from) {
            return {
                transform: `translateY(${drag.dy}px)`,
                zIndex: 2,
                position: "relative",
                background: "var(--hover-bg)",
                boxShadow: "0 2px 14px rgba(0, 0, 0, 0.18)",
            };
        }
        if (idx > drag.from && idx <= drag.target) {
            return { transform: `translateY(${-drag.rowH}px)` };
        }
        if (idx < drag.from && idx >= drag.target) {
            return { transform: `translateY(${drag.rowH}px)` };
        }
        return undefined;
    };

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
                        className={`icon-btn queue-search-toggle ${searchOpen ? "active" : ""}`}
                        title="搜索队列"
                        onClick={() => {
                            if (searchOpen) {
                                search.close();
                            }
                            setSearchOpen(!searchOpen);
                        }}
                    >
                        <IconSearch size={18} />
                    </button>
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
                {searchOpen && (
                    <div className="queue-search">
                        <div className="search-input-wrap">
                            <IconSearch size={16} />
                            <input
                                autoFocus
                                value={search.query}
                                placeholder="搜索队列中的歌曲"
                                onChange={(e) => search.setQuery(e.target.value)}
                            />
                            {search.query && (
                                <button
                                    className="ls-clear"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => search.setQuery("")}
                                >
                                    <IconClose size={12} />
                                </button>
                            )}
                        </div>
                    </div>
                )}
                <div className="queue-list" ref={listRef}>
                    {viewList.map((item, idx) => {
                        const isCurrent =
                            currentMusic?.id === item.id && currentMusic?.platform === item.platform;
                        const shift = rowShiftStyle(idx);
                        return (
                            <div
                                key={`${item.platform}-${item.id}-${idx}`}
                                className={`queue-row ${isCurrent ? "current" : ""} ${
                                    shift && idx !== drag?.from ? "drag-shift" : ""
                                }`}
                                style={shift}
                                onClick={() => {
                                    if (!drag) {
                                        TrackPlayerSingleton.play(item);
                                    }
                                }}
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
                                {!search.active && (
                                    <button
                                        className="queue-drag-handle"
                                        title="拖动排序"
                                        onPointerDown={(e) => onDragStart(e, idx)}
                                        onPointerMove={onDragMove}
                                        onPointerUp={onDragEnd}
                                        onPointerCancel={onDragEnd}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <IconMenu size={14} />
                                    </button>
                                )}
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
                    {search.active && !viewList.length && (
                        <div className="empty-tip">没有找到「{search.query.trim()}」相关的歌曲</div>
                    )}
                </div>
            </div>
        </>
    );
}
