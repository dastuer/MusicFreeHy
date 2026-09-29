import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { homeTabAtom, openDrawer } from "@/core/uiAtoms";
import { getPlugins, type SerializedPlugin } from "@/core/ipc";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { tryPluginMethod } from "@/core/pluginUtils";
import Cover from "@/components/base/Cover";
import Spinner from "@/components/base/Spinner";
import { navigate } from "@/core/router";
import {
    IconMenu,
    IconSearch,
    IconToplist,
    IconListMusic,
    IconHistory,
    IconPlay,
    IconHeadphone,
    IconChevronDown,
} from "@/components/base/Icons";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { getMusicHistory } from "@/core/musicHistory";
import { formatPlayCount } from "@/core/utils";

/**
 * 发现页：参考网易云音乐手机版首页。
 *  - 推荐：快捷入口 + 精选歌单 + 最近在听
 *  - 歌单：标签 + 推荐歌单网格（来自音源插件）
 *  - 排行榜：榜单分组（来自音源插件 getTopLists）
 */

const PAGE = "home";
const TABS = [
    { id: "recommend", label: "推荐" },
    { id: "sheets", label: "歌单" },
    { id: "toplist", label: "排行榜" },
] as const;

type HomeTab = (typeof TABS)[number]["id"];

export default function HomePage() {
    const tab = useAtomValue(homeTabAtom);
    const setTab = useSetAtom(homeTabAtom);

    return (
        <div className="page">
            <div className="home-topbar">
                <button className="icon-btn" onClick={() => openDrawer()}>
                    <IconMenu size={22} />
                </button>
                <div className="home-tabs">
                    {TABS.map((t) => (
                        <span
                            key={t.id}
                            className={`home-tab ${tab === t.id ? "active" : ""}`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </span>
                    ))}
                </div>
                <button className="icon-btn" onClick={() => navigate("search")}>
                    <IconSearch size={21} />
                </button>
            </div>

            {tab === "toplist" ? (
                <TopListTab />
            ) : tab === "sheets" ? (
                <SheetsTab />
            ) : (
                <RecommendTab goTab={setTab} />
            )}
        </div>
    );
}

function RecommendTab({ goTab }: { goTab: (t: HomeTab) => void }) {
    const [history, setHistory] = useState<IMusic.IMusicItem[]>([]);

    useEffect(() => {
        setHistory(
            getMusicHistory()
                .slice(0, 8)
                .map(({ playAt, ...item }: any) => item as IMusic.IMusicItem),
        );
    }, []);

    return (
        <>
            <div className="quick-row">
                <div className="quick-item" onClick={() => navigate("topList")}>
                    <span className="q-icon">
                        <IconToplist size={21} />
                    </span>
                    排行榜
                </div>
                <div className="quick-item" onClick={() => goTab("sheets")}>
                    <span className="q-icon">
                        <IconListMusic size={21} />
                    </span>
                    推荐歌单
                </div>
                <div className="quick-item" onClick={() => navigate("search")}>
                    <span className="q-icon">
                        <IconSearch size={21} />
                    </span>
                    搜索
                </div>
                <div className="quick-item" onClick={() => navigate("history")}>
                    <span className="q-icon">
                        <IconHistory size={21} />
                    </span>
                    历史
                </div>
            </div>

            <RecommendSheetsRow goTab={goTab} />

            <div className="section-title">
                最近在听
                {history.length > 0 && (
                    <span
                        className="section-more"
                        onClick={() =>
                            TrackPlayerSingleton.playWithReplacePlayList(
                                history[0],
                                history,
                                "home-recent",
                            )
                        }
                    >
                        <IconPlay size={12} />
                        播放全部
                    </span>
                )}
            </div>
            {!history.length ? (
                <div className="empty-tip" style={{ padding: "26px 24px" }}>
                    还没有播放记录
                    <br />
                    去搜索一首歌开始听吧
                </div>
            ) : (
                history.map((item) => (
                    <div
                        key={`${item.platform}-${item.id}`}
                        className="song-row"
                        onClick={() => {
                            const idx = TrackPlayerSingleton.getMusicIndexInPlayList(item);
                            if (idx >= 0) {
                                TrackPlayerSingleton.play(item);
                            } else {
                                TrackPlayerSingleton.playWithReplacePlayList(
                                    item,
                                    history,
                                    "home-recent",
                                );
                            }
                        }}
                    >
                        <Cover src={item.artwork} size={46} radius={8} />
                        <div className="song-row-info">
                            <div className="song-row-title">{item.title}</div>
                            <div className="song-row-sub">
                                {item.artist}
                                {item.album ? ` · ${item.album}` : ""}
                            </div>
                        </div>
                        <span className="song-row-play">
                            <IconPlay size={16} />
                        </span>
                    </div>
                ))
            )}
        </>
    );
}

/** 推荐 tab 的精选歌单横滑行（取默认标签的第一页，加载失败时静默隐藏） */
function RecommendSheetsRow({ goTab }: { goTab: (t: HomeTab) => void }) {
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [sheets, setSheets] = useState<IMusic.IMusicSheetItemBase[]>([]);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!plugins) {
            return;
        }
        let cancelled = false;
        (async () => {
            const tagCandidates = pickSourcePlugins(plugins, "getRecommendSheetTags", sourceHash);
            const tagsRes = await tryPluginMethod<any>(tagCandidates, "getRecommendSheetTags");
            const tags = tagsRes?.data
                ? [
                      ...(tagsRes.data.pinned ?? []),
                      ...(tagsRes.data.data ?? []).flatMap((g: any) => g.data ?? []),
                  ].filter((t: any) => t && typeof t === "object")
                : [];
            if (cancelled || !tags.length) {
                return;
            }
            const sheetCandidates = pickSourcePlugins(
                plugins,
                "getRecommendSheetsByTag",
                sourceHash,
            );
            const res = await tryPluginMethod<any>(sheetCandidates, "getRecommendSheetsByTag", [
                tags[0],
                1,
            ]);
            if (!cancelled && res?.data?.data) {
                setSheets(
                    (res.data.data as IMusic.IMusicSheetItemBase[])
                        .filter((it) => it && typeof it === "object")
                        .slice(0, 12),
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [plugins, sourceHash]);

    if (!sheets.length) {
        return null;
    }

    return (
        <>
            <div className="section-title">
                精选歌单
                <span className="section-more" onClick={() => goTab("sheets")}>
                    更多
                </span>
            </div>
            <div className="hscroll">
                {sheets.map((it) => (
                    <div
                        key={`${it.platform}-${it.id}`}
                        className="sheet-card-h"
                        onClick={() => navigate("sheetDetail", { sheetItem: it })}
                    >
                        <Cover src={it.artwork} radius={12} className="sheet-grid-cover">
                            <span className="card-playcount">
                                <IconHeadphone size={11} />
                                {formatPlayCount(it.playCount)}
                            </span>
                        </Cover>
                        <div className="card-title">{it.title}</div>
                    </div>
                ))}
            </div>
        </>
    );
}

/** 推荐歌单（标签 + 网格） */
function SheetsTab() {
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [allTags, setAllTags] = useState<any[]>([]);
    const [activeTag, setActiveTag] = useState<any>(null);
    const [sheets, setSheets] = useState<IMusic.IMusicSheetItemBase[]>([]);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    // 分类标签折叠：默认最多两行，超出时末位显示「更多」
    const [expanded, setExpanded] = useState(false);
    const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
    // 每次窗口尺寸变化都 +1：初始未溢出时 visibleCount 已是最大值，仅改它不会触发重算
    const [layoutNonce, setLayoutNonce] = useState(0);
    const tagsRef = useRef<HTMLDivElement | null>(null);
    const moreRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!plugins) {
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            setSheets([]);
            setPage(1);
            setIsEnd(false);
            const candidates = pickSourcePlugins(plugins, "getRecommendSheetTags", sourceHash);
            const res = await tryPluginMethod<any>(candidates, "getRecommendSheetTags");
            if (cancelled) {
                return;
            }
            if (res?.data) {
                // 插件数据不完全可信：过滤掉 null / 非对象条目，避免渲染时读属性崩溃
                const tags = [
                    ...(res.data.pinned ?? []),
                    ...(res.data.data ?? []).flatMap((g: any) => g.data ?? []),
                ].filter((t: any) => t && typeof t === "object");
                setAllTags(tags);
                setActiveTag(tags[0] ?? null);
                setExpanded(false);
                setVisibleCount(Number.MAX_SAFE_INTEGER);
            } else {
                setAllTags([]);
                setActiveTag(null);
                setError(
                    candidates.length
                        ? "音源加载失败，试试切换音源"
                        : "还没有支持推荐歌单的音源，先去「我的 → 插件管理」安装一个吧",
                );
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [plugins, sourceHash]);

    const fetchSheets = useCallback(
        async (tag: any, pageNum: number, replace: boolean) => {
            replace ? setLoading(true) : setLoadingMore(true);
            const candidates = pickSourcePlugins(
                plugins ?? [],
                "getRecommendSheetsByTag",
                sourceHash,
            );
            const res = await tryPluginMethod<any>(candidates, "getRecommendSheetsByTag", [
                tag,
                pageNum,
            ]);
            if (res?.data?.data) {
                const fresh = (res.data.data as IMusic.IMusicSheetItemBase[]).filter(
                    (it) => it && typeof it === "object",
                );
                setSheets((prev) => {
                    if (replace) {
                        return fresh;
                    }
                    const seen = new Set(prev.map((it) => `${it.platform}-${it.id}`));
                    return [...prev, ...fresh.filter((it) => !seen.has(`${it.platform}-${it.id}`))];
                });
                setIsEnd(!!res.data.isEnd || !fresh.length);
            } else {
                if (replace) {
                    setSheets([]);
                }
                setIsEnd(true);
                if (replace && !candidates.length) {
                    setError("当前音源不支持推荐歌单");
                }
            }
            setLoading(false);
            setLoadingMore(false);
        },
        [plugins, sourceHash],
    );

    useEffect(() => {
        if (activeTag !== null) {
            fetchSheets(activeTag, 1, true);
        }
    }, [activeTag, fetchSheets]);

    // 触底加载更多
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting) && !isEnd && !loadingMore && !loading) {
                    const next = page + 1;
                    setPage(next);
                    fetchSheets(activeTag, next, false);
                }
            },
            { rootMargin: "600px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [isEnd, loadingMore, loading, page, activeTag, fetchSheets]);

    // 分类标签折叠：计算可见数量，保证「更多」落在两行以内
    useLayoutEffect(() => {
        const container = tagsRef.current;
        if (!container || !allTags.length || expanded) {
            return;
        }
        const chips = Array.from(
            container.querySelectorAll<HTMLElement>("[data-tag-chip]"),
        );
        if (!chips.length) {
            return;
        }
        const rowTops = [...new Set(chips.map((el) => el.offsetTop))].sort(
            (a, b) => a - b,
        );
        if (visibleCount >= allTags.length) {
            // 初次渲染：全部标签都在位，判断是否超过两行
            if (rowTops.length <= 2) {
                return;
            }
            const twoRowCount = chips.filter(
                (el) => el.offsetTop <= rowTops[1],
            ).length;
            // 末位让给「更多」，保证加上它仍只有两行
            setVisibleCount(Math.max(1, twoRowCount - 1));
            return;
        }
        // 已折叠：若「更多」掉到第三行，再收起一个
        const moreEl = moreRef.current;
        if (moreEl && rowTops.length >= 2 && moreEl.offsetTop > rowTops[1]) {
            setVisibleCount((prev) => Math.max(1, prev - 1));
        }
    }, [allTags, expanded, visibleCount, layoutNonce]);

    // 窗口尺寸变化时重新计算折叠
    useEffect(() => {
        if (expanded) {
            return;
        }
        const onResize = () => {
            setVisibleCount(Number.MAX_SAFE_INTEGER);
            setLayoutNonce((n) => n + 1);
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [expanded]);

    return (
        <>
            <div className="section-title" style={{ paddingBottom: 4 }}>
                推荐歌单
            </div>
            <div ref={tagsRef} className="sheet-tags" style={{ paddingBottom: 8 }}>
                {(expanded ? allTags : allTags.slice(0, visibleCount)).map((tag: any, idx: number) => (
                    <span
                        key={idx}
                        data-tag-chip
                        className={`sheet-tag ${activeTag === tag ? "active" : ""}`}
                        onClick={() => setActiveTag(tag)}
                    >
                        {tag.title}
                    </span>
                ))}
                {!expanded && visibleCount < allTags.length && (
                    <span
                        ref={moreRef}
                        className="sheet-tag-more"
                        onClick={() => setExpanded(true)}
                    >
                        更多
                        <IconChevronDown size={12} strokeWidth={2.4} />
                    </span>
                )}
                {expanded && visibleCount < allTags.length && (
                    <span
                        className="sheet-tag-more open"
                        onClick={() => setExpanded(false)}
                    >
                        收起
                        <IconChevronDown size={12} strokeWidth={2.4} />
                    </span>
                )}
            </div>
            {error ? (
                <div className="error-tip">{error}</div>
            ) : (
                <div className="sheet-grid">
                    {sheets.map((it) => (
                        <SheetGridCard key={`${it.platform}-${it.id}`} item={it} />
                    ))}
                </div>
            )}
            {loading && (
                <div className="loading-tip loading-spin">
                    <Spinner size={20} />
                    加载中…
                </div>
            )}
            {loadingMore && <div className="loading-tip">加载更多…</div>}
            {isEnd && sheets.length > 0 && <div className="loading-tip">没有更多了</div>}
            <div ref={sentinelRef} />
        </>
    );
}

function SheetGridCard({ item }: { item: IMusic.IMusicSheetItemBase }) {
    return (
        <div
            className="sheet-card-h"
            onClick={() => navigate("sheetDetail", { sheetItem: item })}
        >
            <Cover src={item.artwork} radius={12} className="sheet-grid-cover">
                <span className="card-playcount">
                    <IconHeadphone size={11} />
                    {formatPlayCount(item.playCount)}
                </span>
            </Cover>
            <div className="card-title">{item.title}</div>
        </div>
    );
}

/** 排行榜 */
function TopListTab() {
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [groups, setGroups] = useState<{ title: string; data: IMusic.IMusicSheetItemBase[] }[]>(
        [],
    );
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!plugins) {
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            const candidates = pickSourcePlugins(plugins, "getTopLists", sourceHash);
            const res = await tryPluginMethod<any>(candidates, "getTopLists");
            if (cancelled) {
                return;
            }
            const raw = res?.data;
            // 兼容两种结构：[{title, data:[...]}] 分组形态 或 平铺榜单数组
            const normalized: { title: string; data: IMusic.IMusicSheetItemBase[] }[] = [];
            if (Array.isArray(raw)) {
                const flat: IMusic.IMusicSheetItemBase[] = [];
                for (const g of raw) {
                    if (Array.isArray(g?.data)) {
                        normalized.push({
                            title: g.title ?? "榜单",
                            data: g.data.filter((it: any) => it && typeof it === "object"),
                        });
                    } else if (g?.id !== undefined) {
                        flat.push(g);
                    }
                }
                if (!normalized.length && flat.length) {
                    normalized.push({ title: "榜单", data: flat });
                }
            }
            setGroups(normalized);
            if (!normalized.length) {
                setError(candidates.length ? "榜单加载失败" : "还没有支持排行榜的音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [plugins, sourceHash]);

    return (
        <>
            <div className="section-title" style={{ paddingBottom: 4 }}>
                排行榜
            </div>
            {error ? (
                <div className="error-tip">{error}</div>
            ) : loading ? (
                <div className="loading-tip loading-spin" style={{ paddingTop: 24 }}>
                    <Spinner size={20} />
                    加载中…
                </div>
            ) : (
                groups.map((g, gi) => (
                    <div key={gi}>
                        {g.title && (
                            <div
                                className="section-title"
                                style={{ padding: "12px 16px 6px", fontSize: 14.5 }}
                            >
                                {g.title}
                            </div>
                        )}
                        <div className="hscroll">
                            {g.data.map((it) => (
                                <div
                                    key={`${it.platform}-${it.id}`}
                                    className="sheet-card-h"
                                    onClick={() => navigate("topListDetail", { topListItem: it })}
                                >
                                    <Cover src={it.artwork} radius={12} className="sheet-grid-cover">
                                        <span className="card-playcount">
                                            <IconHeadphone size={11} />
                                            {formatPlayCount(it.playCount)}
                                        </span>
                                    </Cover>
                                    <div className="card-title">{it.title}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            )}
        </>
    );
}

