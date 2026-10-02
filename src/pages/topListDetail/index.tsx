import { cssUrl } from "@/core/utils";
import { useEffect, useRef, useState } from "react";
import { useCurrentRoute, goBack } from "@/core/router";
import { tryPluginMethod } from "@/core/pluginUtils";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { getPlugins } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import MusicList from "@/components/base/MusicList";
import AutoLoadMore from "@/components/base/AutoLoadMore";
import MusicListSkeleton from "@/components/base/MusicListSkeleton";
import Cover from "@/components/base/Cover";
import PlayAllBar from "@/components/base/PlayAllBar";
import SelectActionsBar from "@/components/base/SelectActionsBar";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useMusicMultiSelect } from "@/hooks/useMusicMultiSelect";
import { useListSearch } from "@/hooks/useListSearch";
import { IconBack, IconSearch } from "@/components/base/Icons";
import { showToast } from "@/core/uiAtoms";

/** 排行榜详情页：getTopListDetail 分页加载 */

export default function TopListDetailPage() {
    const route = useCurrentRoute();
    const topListItem: IMusic.IMusicSheetItemBase | undefined = route.params.topListItem;
    const [plugins, setPlugins] = useState<any[] | null>(null);
    const sourceHash = useGlobalSource();
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [isEnd, setIsEnd] = useState(false);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 吸顶顶栏：滚过 hero 后变实底并显示榜单名
    const topbarRef = useRef<HTMLDivElement | null>(null);
    const heroRef = useRef<HTMLDivElement | null>(null);
    const [topSolid, setTopSolid] = useState(false);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!topListItem) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const res = await tryPluginMethod<any>(
                pickSourcePlugins(plugins ?? [], "getTopListDetail", sourceHash),
                "getTopListDetail",
                [topListItem, 1],
            );
            if (cancelled) {
                return;
            }
            if (res?.data) {
                setMusicList(res.data.musicList ?? []);
                setIsEnd(!!res.data.isEnd || !(res.data.musicList ?? []).length);
            } else {
                setMusicList([]);
                setIsEnd(true);
                setError("排行榜加载失败，试试切换音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topListItem, plugins, sourceHash]);

    const loadMore = async () => {
        if (!topListItem || loadingMore || isEnd) {
            return;
        }
        setLoadingMore(true);
        const next = page + 1;
        const res = await tryPluginMethod<any>(
            pickSourcePlugins(plugins ?? [], "getTopListDetail", sourceHash),
            "getTopListDetail",
            [topListItem, next],
        );
        if (res?.data?.musicList?.length) {
            const fresh = res.data.musicList as IMusic.IMusicItem[];
            setMusicList((prev) => {
                const seen = new Set(prev.map((it) => `${it.platform}-${it.id}`));
                return [...prev, ...fresh.filter((it) => !seen.has(`${it.platform}-${it.id}`))];
            });
            setIsEnd(!!res.data.isEnd);
            setPage(next);
        } else {
            setIsEnd(true);
        }
        setLoadingMore(false);
    };

    // 局部搜索：搜索已加载部分，播放全部 / 多选范围随之联动
    const search = useListSearch(musicList);
    const viewList = search.active ? search.filtered : musicList;
    const multi = useMusicMultiSelect(musicList, viewList);

    // 切换榜单时退出多选态与搜索态
    useEffect(() => {
        multi.exitSelect();
        search.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topListItem]);

    if (!topListItem) {
        return <div className="empty-tip">榜单不存在</div>;
    }

    const playAll = () => {
        if (viewList.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                viewList[0],
                viewList,
                `toplist:${topListItem.platform}-${topListItem.id}`,
            );
        } else {
            showToast("列表是空的");
        }
    };

    return (
        <div
            className="page"
            style={{ padding: 0 }}
            onScroll={(e) => {
                const topbar = topbarRef.current;
                const hero = heroRef.current;
                if (!topbar || !hero) {
                    return;
                }
                setTopSolid(
                    e.currentTarget.scrollTop >= hero.offsetHeight - topbar.offsetHeight,
                );
            }}
        >
            <div
                className={`sub-header detail-topbar${topSolid || search.open ? " solid" : ""}`}
                ref={topbarRef}
            >
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">
                    {topSolid || search.open ? (topListItem?.title ?? "排行榜") : "排行榜"}
                </span>
                <div className="sub-header-actions">
                    <button
                        className="icon-btn"
                        onClick={() => (search.open ? search.close() : search.setOpen(true))}
                        title="搜索本榜单"
                    >
                        <IconSearch size={20} />
                    </button>
                </div>
            </div>
            {search.open && <ListSearchBar search={search} />}
            <div className="detail-hero" ref={heroRef}>
                <div
                    className="detail-hero-bg"
                    style={{
                        backgroundImage: cssUrl(topListItem.artwork),
                    }}
                />
                <div className="detail-hero-content">
                    <Cover src={topListItem.artwork} size={116} radius={12} fallbackSize={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="detail-hero-title">{topListItem.title}</div>
                        {topListItem.description && (
                            <div className="detail-hero-meta">{topListItem.description}</div>
                        )}
                    </div>
                </div>
            </div>

            <PlayAllBar
                count={viewList.length}
                onPlayAll={playAll}
                selectMode={multi.selectMode}
                selectedCount={multi.selected.length}
                onEnterSelect={musicList.length ? multi.enterSelect : undefined}
                onExitSelect={multi.exitSelect}
                onSelectAll={multi.selectAll}
                onDeselectAll={multi.deselectAll}
            />

            {loading ? (
                <MusicListSkeleton />
            ) : error && !musicList.length ? (
                <div className="error-tip">{error}</div>
            ) : (
                <>
                    <MusicList
                        musicList={viewList}
                        listId={`toplist:${topListItem.platform}-${topListItem.id}`}
                        showIndex
                        selectMode={multi.selectMode}
                        selectedKeys={multi.selectedKeys}
                        onToggleSelect={multi.toggleSelect}
                    />
                    {multi.selectMode && (
                        <SelectActionsBar
                            count={multi.selected.length}
                            downloading={multi.downloading}
                            onDownload={multi.startDownload}
                            onCollect={multi.startCollect}
                        />
                    )}
                    <AutoLoadMore
                        onLoadMore={loadMore}
                        loadingMore={loadingMore}
                        hasMore={!isEnd && musicList.length > 0}
                        itemsLength={musicList.length}
                        showEndTip={musicList.length > 6}
                    />
                </>
            )}
        </div>
    );
}
