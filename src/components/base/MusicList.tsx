import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import Cover from "./Cover";
import {
    TrackPlayerSingleton,
    useCurrentMusic,
    useMusicState,
} from "@/core/trackPlayer";
import { openMusicActions } from "@/core/uiAtoms";
import { toggleLike, getLikedMusicList, mediaKey, likesVersionAtom } from "@/core/musicSheet";
import { navigate } from "@/core/router";
import { formatSeconds } from "@/core/utils";
import { IconCheck, IconHeart, IconMore, IconPlaying } from "./Icons";
import Spinner from "./Spinner";

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
}) {
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const likesVersion = useAtomValue(likesVersionAtom);
    const [likedSet, setLikedSet] = useState<Set<string>>(new Set());
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

    // 已喜欢的集合：一次取喜欢列表建 Set（O(n+m)），
    // 不再逐首 isLikedMusic 扫描；红心状态由 likesVersion 驱动刷新
    useEffect(() => {
        void likesVersion;
        const likes = new Set(getLikedMusicList().map(mediaKey));
        setLikedSet(new Set(safeList.filter((it) => likes.has(mediaKey(it))).map(mediaKey)));
    }, [safeList, likesVersion]);

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

    const onRowClick = (item: IMusic.IMusicItem) => {
        TrackPlayerSingleton.playWithReplacePlayList(item, safeList, listId);
    };

    const buildActions = (item: IMusic.IMusicItem) => {
        const liked = likedSet.has(`${item.platform}-${item.id}`);
        const actions = [] as any[];
        actions.push({
            label: "下一首播放",
            onClick: () => TrackPlayerSingleton.addNext(item),
        });
        actions.push({
            label: liked ? "取消喜欢" : "喜欢",
            onClick: () => {
                const nowLiked = toggleLike(item);
                setLikedSet((prev) => {
                    const next = new Set(prev);
                    if (nowLiked) {
                        next.add(`${item.platform}-${item.id}`);
                    } else {
                        next.delete(`${item.platform}-${item.id}`);
                    }
                    return next;
                });
            },
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
        return actions;
    };

    return (
        <div className={`music-list ${className}`}>
            {visible.map((item, idx) => {
                const isCurrent =
                    currentMusic?.id === item.id && currentMusic?.platform === item.platform;
                const liked = likedSet.has(`${item.platform}-${item.id}`);
                const checked = selectMode && selectedKeys?.has(`${item.platform}-${item.id}`);
                return (
                    <div
                        key={`${item.platform}-${item.id}-${idx}`}
                        className={`music-row ${isCurrent ? "current" : ""} ${checked ? "selected" : ""}`}
                        onClick={() => {
                            if (selectMode) {
                                onToggleSelect?.(item);
                                return;
                            }
                            onRowClick(item);
                        }}
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
                                <span className="row-num">{idx + 1 + indexOffset}</span>
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
                                            const nowLiked = toggleLike(item);
                                            setLikedSet((prev) => {
                                                const next = new Set(prev);
                                                if (nowLiked) {
                                                    next.add(`${item.platform}-${item.id}`);
                                                } else {
                                                    next.delete(`${item.platform}-${item.id}`);
                                                }
                                                return next;
                                            });
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
                                            openMusicActions({
                                                musicItem: item,
                                                actions: buildActions(item),
                                            });
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
            })}
            {visibleCount < musicList.length && (
                <div ref={sentinelRef} className="music-list-sentinel" />
            )}
        </div>
    );
}
