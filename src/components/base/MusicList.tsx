import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import Cover from "./Cover";
import {
    TrackPlayerSingleton,
    qualityRank,
    useCurrentMusic,
    useMusicState,
} from "@/core/trackPlayer";
import { openMusicActions, openSingleSelect } from "@/core/uiAtoms";
import { toggleLike, getLikedMusicList, mediaKey, likesVersionAtom } from "@/core/musicSheet";
import { navigate } from "@/core/router";
import { formatSeconds } from "@/core/utils";
import { IconCheck, IconHeart, IconMore, IconPlaying, IconRefresh } from "./Icons";
import Spinner from "./Spinner";
import {
    downloadMusic,
    downloadTasksAtom,
    getDownloadRecord,
    QUALITY_LABEL,
    retryDownloadTask,
} from "@/core/musicDownload";

/**
 * 任务态行标识：taskRowOf 对某行返回非空时该行渲染为下载任务行；
 * 实时进度由行内自订阅任务队列获取，不经过页面 props。
 */
export interface IMusicListTaskRow {
    taskKey: string;
}

/** 任务副标题（歌手 · 状态；进度百分比只在行右侧展示） */
function taskSubText(task: {
    status: "pending" | "downloading" | "paused" | "error";
    item: IMusic.IMusicItem;
}) {
    const base = task.item.artist || "未知艺术家";
    switch (task.status) {
        case "pending":
            return `${base} · 排队等待`;
        case "downloading":
            return `${base} · 正在下载`;
        case "paused":
            return `${base} · 已暂停`;
        case "error":
            return `${base} · 下载失败`;
    }
}

/**
 * 下载任务行实时内容：自行订阅任务队列，进度刷新只重渲染本行，
 * 不牵动页面与其余列表行（配合 MusicListRow 的 memo 保证长列表滚动流畅）。
 */
function DownloadTaskRowLive({
    taskKey,
    item,
    index,
    showIndex,
    indexOffset,
}: {
    taskKey: string;
    item: IMusic.IMusicItem;
    index: number;
    showIndex: boolean;
    indexOffset: number;
}) {
    const task = useAtomValue(downloadTasksAtom).find((t) => t.key === taskKey);
    if (!task) {
        // 任务刚被移除、列表结构尚未重建的过渡帧
        return null;
    }
    const failed = task.status === "error";
    // 灰底条：封面等高、左缘与封面左缘对齐（42px）、右缘与更多图标右缘对齐（14px），
    // 宽度按下载进度从满收窄到 0
    const frac = failed
        ? 1
        : task.progress >= 0
          ? (100 - Math.min(100, Math.max(0, task.progress))) / 100
          : 1;
    const pct = !failed && task.progress >= 0 ? Math.round(task.progress) : undefined;
    return (
        <div className={`music-row dl-task-row ${failed ? "failed" : ""}`}>
            <div
                className="dl-task-mask"
                style={{ width: `calc((100% - 56px) * ${frac.toFixed(4)})` }}
            />
            <div className="music-row-index">
                {showIndex ? <span className="row-num">{index + 1 + indexOffset}</span> : null}
            </div>
            <Cover src={item.artwork} size={44} radius={6} className="music-row-cover">
                {failed && (
                    <button
                        className="dl-task-retry"
                        onClick={() => retryDownloadTask(task.key)}
                        title="重试下载"
                    >
                        <IconRefresh size={18} />
                    </button>
                )}
            </Cover>
            <div className="music-row-info">
                <div className="music-row-title">{item.title}</div>
                <div className="music-row-sub">{taskSubText(task)}</div>
            </div>
            <div className="music-row-album">{item.album}</div>
            <div className="music-row-actions">
                {pct !== undefined && <span className="dl-task-pct">{pct}%</span>}
            </div>
        </div>
    );
}

/** 单行（memo 化）：页面级刷新时未变化的行直接跳过，保证长列表滚动流畅 */
const MusicListRow = memo(function MusicListRow({
    item,
    index,
    showIndex,
    indexOffset,
    selectMode,
    checked,
    isCurrent,
    musicState,
    liked,
    taskRow,
    onRowClick,
    onToggleLike,
    onMore,
}: {
    item: IMusic.IMusicItem;
    index: number;
    showIndex: boolean;
    indexOffset: number;
    selectMode: boolean;
    checked: boolean;
    isCurrent: boolean;
    musicState: string;
    liked: boolean;
    taskRow?: IMusicListTaskRow;
    onRowClick: (item: IMusic.IMusicItem) => void;
    onToggleLike: (item: IMusic.IMusicItem) => void;
    onMore: (item: IMusic.IMusicItem) => void;
}) {
    if (taskRow) {
        return (
            <DownloadTaskRowLive
                taskKey={taskRow.taskKey}
                item={item}
                index={index}
                showIndex={showIndex}
                indexOffset={indexOffset}
            />
        );
    }
    return (
        <div
            className={`music-row ${isCurrent ? "current" : ""} ${checked ? "selected" : ""}`}
            onClick={() => onRowClick(item)}
        >
            <div className="music-row-index">
                {selectMode ? (
                    <span className={`row-check ${checked ? "checked" : ""}`}>
                        <IconCheck size={12} />
                    </span>
                ) : isCurrent && musicState === "loading" ? (
                    <Spinner size={14} strokeWidth={2.2} />
                ) : isCurrent && musicState === "playing" ? (
                    <IconPlaying size={16} />
                ) : showIndex ? (
                    <span className="row-num">{index + 1 + indexOffset}</span>
                ) : null}
            </div>
            <Cover src={item.artwork} size={44} radius={6} className="music-row-cover" />
            <div className="music-row-info">
                <div className="music-row-title">{item.title}</div>
                <div className="music-row-sub">
                    {item.artist}
                    {item.album ? ` · ${item.album}` : ""}
                </div>
            </div>
            <div className="music-row-album">{item.album}</div>
            <div className="music-row-actions">
                {!selectMode && (
                    <>
                        <button
                            className={`icon-btn like-btn ${liked ? "liked" : ""}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleLike(item);
                            }}
                            title={liked ? "取消喜欢" : "喜欢"}
                        >
                            <IconHeart size={17} filled={liked} />
                        </button>
                        <span className="music-row-duration">
                            {formatSeconds(item.duration)}
                        </span>
                        <button
                            className="icon-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onMore(item);
                            }}
                            title="更多操作"
                        >
                            <IconMore size={17} />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
});

/**
 * 歌曲列表（Pad 形态）：序号/播放中动画、封面、歌名+歌手、专辑（宽屏）、时长、红心、更多。
 * 渐进渲染：导航帧只构建首屏 FIRST_STEP 行，随后每帧补齐 FILL_CHUNK 行到 RENDER_STEP，
 * 滚动触底按 SCROLL_STEP 追加 —— 一次性渲染 150+ 行复杂 DOM 会卡住页面进入动画。
 * 多选态：序号位变勾选圈，点行切换选中（由页面驱动）。
 */

/** 首屏（导航帧）构建的行数：一屏 + 余量，约 30 行 × 58px ≈ 1700px */
const FIRST_STEP = 30;
/** 渲染窗口：首屏后分帧补齐到的行数 */
const RENDER_STEP = 150;
/** 分帧补齐时每帧追加的行数 */
const FILL_CHUNK = 60;
/** 滚动触底时每批追加的行数（大批会阻塞滚动） */
const SCROLL_STEP = 50;

export default function MusicList({
    musicList,
    listId,
    onRemoveItem,
    showIndex = true,
    indexOffset = 0,
    className = "",
    selectMode = false,
    selectedKeys,
    onToggleSelect,
    removeActionLabel = "移出本列表",
    extraActions,
    hideDownload = false,
    taskRowOf,
}: {
    musicList: IMusic.IMusicItem[];
    listId: string;
    onRemoveItem?: (item: IMusic.IMusicItem) => void;
    showIndex?: boolean;
    /** 序号偏移：页面上方还有其他行（如下载中任务）时，本列表序号接在其后 */
    indexOffset?: number;
    className?: string;
    selectMode?: boolean;
    selectedKeys?: Set<string>;
    onToggleSelect?: (item: IMusic.IMusicItem) => void;
    removeActionLabel?: string;
    /** 追加到「更多」菜单的操作（本地音乐的查看详情等页面级动作） */
    extraActions?: (item: IMusic.IMusicItem) => {
        label: string;
        onClick: () => void;
        danger?: boolean;
    }[];
    /** 隐藏「下载」菜单项（本地音乐 / 我的下载页没有下载意义） */
    hideDownload?: boolean;
    /** 行级下载任务：与已完成记录交织成统一列表时，由页面按歌曲返回任务态参数 */
    taskRowOf?: (item: IMusic.IMusicItem) => IMusicListTaskRow | undefined;
}) {
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const likesVersion = useAtomValue(likesVersionAtom);
    // 全局喜欢集合：与具体列表无关，懒初始化一次；仅喜欢操作 / likesVersion 变化时重建，
    // 不放进每帧渲染的依赖 —— 否则下载进度刷新会反复解析 localStorage 并引发额外渲染
    const [likedSet, setLikedSet] = useState<Set<string>>(
        () => new Set(getLikedMusicList().map(mediaKey)),
    );
    const [visibleCount, setVisibleCount] = useState(FIRST_STEP);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    // 插件数据兜底：滤掉 null / 非对象条目，避免渲染读取属性时崩溃
    const safeList = useMemo(
        () => musicList.filter((it: any) => it && typeof it === "object"),
        [musicList],
    );

    // 换列表重置回首屏窗口
    useEffect(() => {
        setVisibleCount(FIRST_STEP);
        // 只跟 listId 走：musicList 每次渲染都是新数组（逐项重建），不能作为重置依据，
        // 否则列表页任何状态变化（如匹配进度刷新）都会把渲染窗口缩回顶部
    }, [listId]);

    // 首屏后分帧补齐到渲染窗口：每帧 FILL_CHUNK 行，
    // 避免导航帧一次性构建整个窗口的 DOM 卡住页面进入
    useEffect(() => {
        const target = Math.min(safeList.length, RENDER_STEP);
        if (visibleCount >= target) {
            return;
        }
        const raf = requestAnimationFrame(() => {
            setVisibleCount((c) => Math.min(c + FILL_CHUNK, target));
        });
        return () => cancelAnimationFrame(raf);
    }, [visibleCount, safeList.length]);

    // 已喜欢的集合：一次取喜欢列表建 Set（O(n+m)），不再逐首 isLikedMusic 扫描
    useEffect(() => {
        setLikedSet(new Set(getLikedMusicList().map(mediaKey)));
    }, [likesVersion]);

    // 渐进渲染：滚动到底部附近时再多渲染一批
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setVisibleCount((c) => Math.min(c + SCROLL_STEP, safeList.length));
                }
            },
            { rootMargin: "400px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [safeList.length]);

    const visible = safeList.slice(0, visibleCount);

    // 行级回调：全部稳定引用（依赖均为 memo 化数据 / 低频状态），
    // 配合 MusicListRow 的 memo，下载进度等高频刷新时未变化行直接跳过
    const handleRowClick = useCallback(
        (item: IMusic.IMusicItem) => {
            if (selectMode) {
                onToggleSelect?.(item);
                return;
            }
            TrackPlayerSingleton.playWithReplacePlayList(item, safeList, listId);
        },
        [selectMode, onToggleSelect, safeList, listId],
    );

    const handleToggleLike = useCallback((item: IMusic.IMusicItem) => {
        const nowLiked = toggleLike(item);
        setLikedSet((prev) => {
            const next = new Set(prev);
            const k = `${item.platform}-${item.id}`;
            if (nowLiked) {
                next.add(k);
            } else {
                next.delete(k);
            }
            return next;
        });
    }, []);

    const handleMore = useCallback(
        (item: IMusic.IMusicItem) => {
            const liked = likedSet.has(`${item.platform}-${item.id}`);
            const actions = [] as any[];
            actions.push({
                label: "下一首播放",
                onClick: () => TrackPlayerSingleton.addNext(item),
            });
            actions.push({
                label: liked ? "取消喜欢" : "喜欢",
                onClick: () => handleToggleLike(item),
            });
            if (item.albumId !== undefined) {
                actions.push({
                    label: "查看专辑",
                    onClick: () =>
                        navigate("albumDetail", {
                            albumItem: {
                                id: item.albumId,
                                platform: item.platform,
                                title: item.album,
                                artwork: item.artwork,
                                artist: item.artist,
                            },
                        }),
                });
            }
            // 本地歌曲没有线上音源可解析，任何列表里都不给下载入口
            if (!hideDownload && item.platform !== "local") {
                actions.push({
                    label: "下载",
                    onClick: () => {
                        // 打开菜单时才查下载记录（不订阅记录版本，避免下载完成刷新整列表）；
                        // 已下载标注与播放页下载音质面板同规则：同档/更低跳过、更高覆盖升级
                        const existing = getDownloadRecord(item)?.quality;
                        const qualities: IMusic.IQualityKey[] = [
                            "standard",
                            "high",
                            "super",
                            "low",
                        ];
                        openSingleSelect({
                            title: "下载音质",
                            options: qualities.map((q) => {
                                let desc: string | undefined;
                                if (existing) {
                                    const rank = qualityRank(q) - qualityRank(existing);
                                    if (rank < 0) {
                                        desc = "已有更高音质，下载会跳过";
                                    } else if (rank === 0) {
                                        desc = "已下载，重复下载会跳过";
                                    } else {
                                        desc = "覆盖升级现有文件";
                                    }
                                }
                                return { value: q, label: QUALITY_LABEL[q], desc };
                            }),
                            onSelect: (v) => {
                                downloadMusic(item, v as IMusic.IQualityKey);
                            },
                        });
                    },
                });
            }
            for (const extra of extraActions?.(item) ?? []) {
                actions.push(extra);
            }
            if (onRemoveItem) {
                actions.push({
                    label: removeActionLabel,
                    danger: true,
                    onClick: () => onRemoveItem(item),
                });
            }
            openMusicActions({ musicItem: item, actions });
        },
        [likedSet, extraActions, hideDownload, onRemoveItem, removeActionLabel, handleToggleLike],
    );

    return (
        <div className={`music-list ${className}`}>
            {visible.map((item, idx) => {
                const taskRow = taskRowOf?.(item);
                return (
                    <MusicListRow
                        key={`${item.platform}-${item.id}-${idx}`}
                        item={item}
                        index={idx}
                        showIndex={showIndex}
                        indexOffset={indexOffset}
                        selectMode={selectMode}
                        checked={Boolean(selectMode && selectedKeys?.has(`${item.platform}-${item.id}`))}
                        isCurrent={
                            !taskRow &&
                            currentMusic?.id === item.id &&
                            currentMusic?.platform === item.platform
                        }
                        musicState={musicState}
                        liked={likedSet.has(`${item.platform}-${item.id}`)}
                        taskRow={taskRow}
                        onRowClick={handleRowClick}
                        onToggleLike={handleToggleLike}
                        onMore={handleMore}
                    />
                );
            })}
            {visibleCount < musicList.length && (
                <div ref={sentinelRef} className="music-list-sentinel" />
            )}
        </div>
    );
}
