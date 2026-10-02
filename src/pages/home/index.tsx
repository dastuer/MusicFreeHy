import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { homeTabAtom, openDrawer, showToast } from "@/core/uiAtoms";
import { getPlugins, type SerializedPlugin } from "@/core/ipc";
import { pickSourcePlugins, useGlobalSource, usePluginsVersion } from "@/core/mediaSource";
import { tryPluginMethod } from "@/core/pluginUtils";
import Cover from "@/components/base/Cover";
import Spinner from "@/components/base/Spinner";
import PullToRefresh from "@/components/base/PullToRefresh";
import { navigate, useCurrentRoute } from "@/core/router";
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
import { useTabSwipe } from "./useTabSwipe";

/**
 * 发现页：参考网易云音乐手机版首页。
 *  - 推荐：快捷入口 + 精选歌单 + 最近在听
 *  - 歌单：标签 + 推荐歌单网格（来自音源插件）
 *  - 排行榜：榜单分组（来自音源插件 getTopLists）
 * 三个子页横向排布做页面缓存：始终挂载，切换 Tab / 跳转详情都不会卸载，
 * 已加载数据与滚动位置原样保留；支持左右滑动切换（useTabSwipe），
 * 下拉可手动刷新当前页数据。
 */

/** 子页向父级登记「刷新自己」的函数；传 null 表示注销 */
type RegisterRefresh = (fn: (() => Promise<void>) | null) => void;

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
    const route = useCurrentRoute();
    const routeActive = route.path === PAGE;
    const tabIndex = Math.max(
        0,
        TABS.findIndex((t) => t.id === tab),
    );
    // 横滑切换 + 红条跟随：手势期间直接写 DOM，确认页变化时由状态驱动补间
    const { panesRef, trackRef, indicatorRef, tabRefs } = useTabSwipe({
        count: TABS.length,
        index: tabIndex,
        onIndexChange: (i) => setTab(TABS[i].id),
        enabled: routeActive,
    });

    return (
        <div className="page home-page">
            <div className="home-topbar">
                <button className="icon-btn" onClick={() => openDrawer()}>
                    <IconMenu size={22} />
                </button>
                <div className="home-tabs">
                    {TABS.map((t, i) => (
                        <span
                            key={t.id}
                            ref={(el) => {
                                tabRefs.current[i] = el;
                            }}
                            className={`home-tab ${tab === t.id ? "active" : ""}`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </span>
                    ))}
                    {/* 红条指示器：位置由 useTabSwipe 测量并驱动，随滑动逐帧跟随 */}
                    <span ref={indicatorRef} className="home-tab-indicator" />
                </div>
                <button className="icon-btn" onClick={() => navigate("search")}>
                    <IconSearch size={21} />
                </button>
            </div>

            {/* 三个子页横向排布常驻，切 tab / 手势滑动平移轨道；数据缓存由各自组件内的状态承担 */}
            <div className="home-panes" ref={panesRef}>
                <div className="home-panes-track" ref={trackRef}>
                    <RecommendTab
                        goTab={setTab}
                        visible={routeActive}
                        active={tab === "recommend"}
                    />
                    <SheetsTab visible={routeActive} />
                    <TopListTab visible={routeActive} />
                </div>
            </div>
        </div>
    );
}

function RecommendTab({
    goTab,
    visible,
    active,
}: {
    goTab: (t: HomeTab) => void;
    /** 路由停留在发现页（三个子页横向排布常驻，不再各自显隐） */
    visible: boolean;
    /** 本子页是当前确认的 tab（滑动切换松手后切换） */
    active: boolean;
}) {
    const [history, setHistory] = useState<IMusic.IMusicItem[]>([]);
    const rowRefreshRef = useRef<(() => Promise<void>) | null>(null);

    const loadHistory = useCallback(() => {
        setHistory(
            getMusicHistory()
                .slice(0, 8)
                .map(({ playAt, ...item }: any) => item as IMusic.IMusicItem),
        );
    }, []);

    // 「最近在听」是本地数据，代价低：每次回到本页（路由或 tab）都同步一次播放记录
    useEffect(() => {
        if (visible && active) {
            loadHistory();
        }
    }, [visible, active, loadHistory]);

    const registerRowRefresh = useCallback<RegisterRefresh>((fn) => {
        rowRefreshRef.current = fn;
    }, []);

    const handleRefresh = useCallback(async () => {
        loadHistory();
        await rowRefreshRef.current?.();
    }, [loadHistory]);

    return (
        <PullToRefresh className="home-pane" visible={visible} onRefresh={handleRefresh}>
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

            <RecommendSheetsRow goTab={goTab} registerRefresh={registerRowRefresh} />

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
        </PullToRefresh>
    );
}

/** 推荐 tab 的精选歌单横滑行（取默认标签的第一页，加载失败时静默隐藏） */
function RecommendSheetsRow({
    goTab,
    registerRefresh,
}: {
    goTab: (t: HomeTab) => void;
    registerRefresh: RegisterRefresh;
}) {
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [sheets, setSheets] = useState<IMusic.IMusicSheetItemBase[]>([]);
    // 代号守卫：并发/重复触发时只让最新一次的结果生效
    const genRef = useRef(0);

    // 首页是常驻缓存页：插件安装/卸载/启停后重新拉取，新音源无需重启即可用
    const pluginsVersion = usePluginsVersion();
    useEffect(() => {
        getPlugins().then(setPlugins);
    }, [pluginsVersion]);

    const load = useCallback(async () => {
        const gen = ++genRef.current;
        const tagCandidates = pickSourcePlugins(
            plugins ?? [],
            "getRecommendSheetTags",
            sourceHash,
        );
        const tagsRes = await tryPluginMethod<any>(tagCandidates, "getRecommendSheetTags");
        if (gen !== genRef.current) {
            return;
        }
        const tags = tagsRes?.data
            ? [
                  ...(tagsRes.data.pinned ?? []),
                  ...(tagsRes.data.data ?? []).flatMap((g: any) => g.data ?? []),
              ].filter((t: any) => t && typeof t === "object")
            : [];
        if (!tags.length) {
            return;
        }
        const sheetCandidates = pickSourcePlugins(
            plugins ?? [],
            "getRecommendSheetsByTag",
            sourceHash,
        );
        const res = await tryPluginMethod<any>(sheetCandidates, "getRecommendSheetsByTag", [
            tags[0],
            1,
        ]);
        if (gen !== genRef.current) {
            return;
        }
        if (res?.data?.data) {
            setSheets(
                (res.data.data as IMusic.IMusicSheetItemBase[])
                    .filter((it) => it && typeof it === "object")
                    .slice(0, 12),
            );
        }
    }, [plugins, sourceHash]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        registerRefresh(load);
        return () => registerRefresh(null);
    }, [registerRefresh, load]);

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
function SheetsTab({ visible }: { visible: boolean }) {
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
    // 异步流程里读「最新值」用的镜像 ref
    const activeTagRef = useRef<any>(null);
    const hasContentRef = useRef(false);
    const tagsGenRef = useRef(0);
    // 下拉刷新重绑选中标签时置位：activeTag 加载 effect 消费一次并跳过，
    // 首页请求由 handleRefresh 统一发起，避免同一页请求发两遍
    const skipNextFetchRef = useRef(false);
    activeTagRef.current = activeTag;
    hasContentRef.current = sheets.length > 0;
    // 音源切换时清空选中分类：旧 tag 对象属于旧音源，保留会导致
    // 高亮停留在旧分类（新音源恰好有同名分类时）而不是第一个分类，
    // 且分类加载 effect 会先拿旧 tag 发一次错误请求
    const [prevSourceHash, setPrevSourceHash] = useState(sourceHash);
    if (prevSourceHash !== sourceHash) {
        setPrevSourceHash(sourceHash);
        setActiveTag(null);
    }
    // 分类标签折叠：默认最多两行，超出时末位显示「更多」
    const [expanded, setExpanded] = useState(false);
    const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
    // 每次窗口尺寸变化都 +1：初始未溢出时 visibleCount 已是最大值，仅改它不会触发重算
    const [layoutNonce, setLayoutNonce] = useState(0);
    const tagsRef = useRef<HTMLDivElement | null>(null);
    const moreRef = useRef<HTMLSpanElement | null>(null);
    // 展开/收起高度过渡：点击时记下实时高度（动画中则是中间值），渲染后由布局效果续接
    const pendingTagsAnimRef = useRef<number | null>(null);
    const tagsAnimCleanupRef = useRef<(() => void) | null>(null);

    // 首页是常驻缓存页：插件安装/卸载/启停后重新拉取，新音源无需重启即可用
    const pluginsVersion = usePluginsVersion();
    useEffect(() => {
        getPlugins().then(setPlugins);
    }, [pluginsVersion]);

    /**
     * 加载标签列表。quiet=true 时由下拉刷新触发：保留旧列表与错误态之外的一切，
     * 刷新失败不清空已缓存内容，由调用方提示。
     * 选中标签在新列表里仍存在时保持不变（刷新不打断用户的选择）。
     */
    const loadTags = useCallback(
        async (quiet = false): Promise<boolean> => {
            const gen = ++tagsGenRef.current;
            if (!quiet) {
                setLoading(true);
                setError(null);
                setSheets([]);
                setPage(1);
                setIsEnd(false);
            }
            const candidates = pickSourcePlugins(plugins ?? [], "getRecommendSheetTags", sourceHash);
            const res = await tryPluginMethod<any>(candidates, "getRecommendSheetTags");
            if (gen !== tagsGenRef.current) {
                return false;
            }
            if (res?.data) {
                // 插件数据不完全可信：过滤掉 null / 非对象条目，避免渲染时读属性崩溃
                const tags = [
                    ...(res.data.pinned ?? []),
                    ...(res.data.data ?? []).flatMap((g: any) => g.data ?? []),
                ].filter((t: any) => t && typeof t === "object");
                setAllTags(tags);
                // 选中标签在新列表里仍存在时改绑到新列表对象（按 title+id 精确匹配，
                // 退回按 title）：chips 渲染的是新对象而高亮按引用比较，沿用旧对象
                // 会让刷新后的分类全部失去选中态
                const prevTag = activeTagRef.current;
                const nextTag = prevTag
                    ? tags.find((t: any) => t.title === prevTag.title && t.id === prevTag.id) ??
                      tags.find((t: any) => t.title === prevTag.title) ??
                      tags[0] ??
                      null
                    : tags[0] ?? null;
                if (quiet && nextTag && nextTag !== prevTag) {
                    skipNextFetchRef.current = true;
                }
                activeTagRef.current = nextTag;
                setActiveTag(nextTag);
                setExpanded(false);
                setVisibleCount(Number.MAX_SAFE_INTEGER);
                if (!nextTag) {
                    // 没有任何可用标签：不会有后续加载，停掉初始 loading
                    if (!quiet) {
                        setLoading(false);
                    }
                }
                return true;
            }
            if (!quiet || !hasContentRef.current) {
                setAllTags([]);
                setError(
                    candidates.length
                        ? "音源加载失败，试试切换音源"
                        : "还没有支持推荐歌单的音源，先去「我的 → 插件管理」安装一个吧",
                );
                if (!quiet) {
                    setLoading(false);
                }
            }
            return false;
        },
        [plugins, sourceHash],
    );

    const fetchSheets = useCallback(
        async (tag: any, pageNum: number, replace: boolean, keepOnError = false) => {
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
            } else if (keepOnError) {
                // 下拉刷新失败：保留旧列表与分页状态，不打断浏览
                setLoading(false);
                setLoadingMore(false);
                return false;
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
            return true;
        },
        [plugins, sourceHash],
    );

    // activeTag 变化 / 下拉刷新 / 音源切换（fetchSheets 身份变化）都会重拉第一页
    useEffect(() => {
        if (activeTag === null) {
            return;
        }
        if (skipNextFetchRef.current) {
            skipNextFetchRef.current = false;
            return;
        }
        fetchSheets(activeTag, 1, true);
    }, [activeTag, fetchSheets]);

    const handleRefresh = useCallback(async () => {
        const tagsOk = await loadTags(true);
        const sheetsOk = await fetchSheets(activeTagRef.current, 1, true, true);
        if (!tagsOk || !sheetsOk) {
            showToast("刷新失败，请检查网络后重试", 2000);
        }
    }, [loadTags, fetchSheets]);

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
        // 三个子页常驻缓存，隐藏时是 display:none，offsetTop 全为 0：
        // 此时测量会误判成「只有一行」且此后无人触发重算（首次加载停在推荐页时
        // 标签正好在隐藏中返回，切到歌单页就会不截断、无「更多」）。
        // 因此只在可见时测量，依赖里带上 visible，重新可见时补测一次。
        if (!visible) {
            return;
        }
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
    }, [allTags, expanded, visibleCount, layoutNonce, visible]);

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

    // 展开/收起时对标签区做高度过渡：点击只记录当前高度并翻转状态，
    // 渲染完成后在这里从记录高度过渡到新内容的自然高度（结束后还原为自适应）
    useLayoutEffect(() => {
        const el = tagsRef.current;
        if (!el) return;
        const trans = "height 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)";
        const startH = pendingTagsAnimRef.current;
        if (startH === null) {
            // 过渡进行中因可见数量重算而重渲染（如展开时旋转屏幕再收起）：
            // 锁定当前动画高度，平滑改道到新的自然高度
            if (el.dataset.tagAnim === "1") {
                const cur = el.getBoundingClientRect().height;
                el.style.transition = "none";
                el.style.height = `${cur}px`;
                void el.offsetHeight;
                el.style.height = "auto";
                const endH = el.getBoundingClientRect().height;
                el.style.height = `${cur}px`;
                void el.offsetHeight;
                el.style.transition = trans;
                el.style.height = `${endH}px`;
            }
            return;
        }
        pendingTagsAnimRef.current = null;
        // 连点打断旧动画：从点击那一刻捕获的高度续接，避免跳变
        tagsAnimCleanupRef.current?.();
        el.style.transition = "none";
        el.style.height = "auto";
        const endH = el.getBoundingClientRect().height;
        if (Math.abs(endH - startH) < 1) {
            el.style.transition = "";
            el.style.height = "";
            return;
        }
        el.style.height = `${startH}px`;
        el.style.overflow = "hidden";
        void el.offsetHeight; // 强制回流锁定起点，否则过渡不生效
        el.style.transition = trans;
        el.style.height = `${endH}px`;
        let timer = 0;
        const onEnd = (e: TransitionEvent) => {
            if (e.target === el && e.propertyName === "height") {
                cleanup();
            }
        };
        const cleanup = () => {
            el.removeEventListener("transitionend", onEnd);
            clearTimeout(timer);
            delete el.dataset.tagAnim;
            el.style.transition = "";
            el.style.height = "";
            el.style.overflow = "";
            tagsAnimCleanupRef.current = null;
        };
        // transitionend 可能因切后台等丢失，按时长兜底清理
        timer = window.setTimeout(cleanup, 340);
        el.addEventListener("transitionend", onEnd);
        el.dataset.tagAnim = "1";
        tagsAnimCleanupRef.current = cleanup;
    }, [expanded, visibleCount]);

    const toggleTags = (next: boolean) => {
        const el = tagsRef.current;
        // 不可见（高度为 0）时没有可过渡的高度，直接切换状态
        const curH = el?.getBoundingClientRect().height ?? 0;
        if (curH < 1) {
            setExpanded(next);
            return;
        }
        pendingTagsAnimRef.current = curH;
        setExpanded(next);
    };

    // 首次挂载 / 音源变化时加载标签（页面缓存后只发生一次，之后靠下拉刷新）
    useEffect(() => {
        loadTags();
    }, [loadTags]);

    return (
        <PullToRefresh className="home-pane" visible={visible} onRefresh={handleRefresh}>
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
                        onClick={() => toggleTags(true)}
                    >
                        更多
                        <IconChevronDown size={12} strokeWidth={2.4} />
                    </span>
                )}
                {expanded && visibleCount < allTags.length && (
                    <span
                        className="sheet-tag-more open"
                        onClick={() => toggleTags(false)}
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
        </PullToRefresh>
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
function TopListTab({ visible }: { visible: boolean }) {
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [groups, setGroups] = useState<{ title: string; data: IMusic.IMusicSheetItemBase[] }[]>(
        [],
    );
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const genRef = useRef(0);
    const hasContentRef = useRef(false);
    hasContentRef.current = groups.length > 0;

    // 首页是常驻缓存页：插件安装/卸载/启停后重新拉取，新音源无需重启即可用
    const pluginsVersion = usePluginsVersion();
    useEffect(() => {
        getPlugins().then(setPlugins);
    }, [pluginsVersion]);

    const load = useCallback(async () => {
        const gen = ++genRef.current;
        setLoading(true);
        setError(null);
        const candidates = pickSourcePlugins(plugins ?? [], "getTopLists", sourceHash);
        const res = await tryPluginMethod<any>(candidates, "getTopLists");
        if (gen !== genRef.current) {
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
        if (normalized.length) {
            setGroups(normalized);
        } else if (!hasContentRef.current) {
            // 没有旧数据可保：按首次加载失败展示错误
            setGroups([]);
            setError(candidates.length ? "榜单加载失败" : "还没有支持排行榜的音源");
        } else {
            // 下拉刷新失败：保留旧数据，提示后原样展示
            showToast("榜单刷新失败，请稍后重试", 2000);
        }
        setLoading(false);
    }, [plugins, sourceHash]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <PullToRefresh className="home-pane" visible={visible} onRefresh={load}>
            <div className="section-title" style={{ paddingBottom: 4 }}>
                排行榜
            </div>
            {error ? (
                <div className="error-tip">{error}</div>
            ) : loading && !groups.length ? (
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
        </PullToRefresh>
    );
}
