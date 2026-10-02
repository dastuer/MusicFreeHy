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
import { IconBack, IconSearch } from "@/components/base/Icons";
import PlayAllBar from "@/components/base/PlayAllBar";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useListSearch } from "@/hooks/useListSearch";
import { showToast } from "@/core/uiAtoms";

/** 专辑详情页：getAlbumInfo 分页加载 */

export default function AlbumDetailPage() {
    const route = useCurrentRoute();
    const albumItem: IAlbum.IAlbumItemBase | undefined = route.params.albumItem;
    const [plugins, setPlugins] = useState<any[] | null>(null);
    const sourceHash = useGlobalSource();
    const [albumInfo, setAlbumInfo] = useState<any>(albumItem ?? null);
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [isEnd, setIsEnd] = useState(false);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 吸顶顶栏：滚过 hero 后变实底并显示专辑名
    const topbarRef = useRef<HTMLDivElement | null>(null);
    const heroRef = useRef<HTMLDivElement | null>(null);
    const [topSolid, setTopSolid] = useState(false);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!albumItem) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const res = await tryPluginMethod<any>(
                pickSourcePlugins(plugins ?? [], "getAlbumInfo", sourceHash),
                "getAlbumInfo",
                [albumItem, 1],
            );
            if (cancelled) {
                return;
            }
            if (res?.data) {
                setAlbumInfo(res.data.albumItem ?? albumItem);
                setMusicList(res.data.musicList ?? []);
                setIsEnd(!!res.data.isEnd || !(res.data.musicList ?? []).length);
            } else {
                setAlbumInfo(albumItem);
                setMusicList([]);
                setIsEnd(true);
                setError("专辑加载失败，试试切换音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [albumItem, plugins, sourceHash]);

    const loadMore = async () => {
        if (!albumItem || loadingMore || isEnd) {
            return;
        }
        setLoadingMore(true);
        const next = page + 1;
        const res = await tryPluginMethod<any>(
            pickSourcePlugins(plugins ?? [], "getAlbumInfo", sourceHash),
            "getAlbumInfo",
            [albumItem, next],
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

    // 局部搜索：搜索已加载部分，播放全部范围随之联动
    const search = useListSearch(musicList);
    const viewList = search.active ? search.filtered : musicList;

    if (!albumItem) {
        return <div className="empty-tip">专辑不存在</div>;
    }

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
                    {topSolid || search.open ? (albumInfo?.title ?? "专辑") : "专辑"}
                </span>
                <div className="sub-header-actions">
                    <button
                        className="icon-btn"
                        onClick={() => (search.open ? search.close() : search.setOpen(true))}
                        title="搜索本专辑"
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
                        backgroundImage: cssUrl(albumInfo?.artwork),
                    }}
                />
                <div className="detail-hero-content">
                    <Cover src={albumInfo?.artwork} size={116} radius={12} fallbackSize={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="detail-hero-title">{albumInfo?.title}</div>
                        <div className="detail-hero-meta">
                            {albumInfo?.artist ? `${albumInfo.artist}` : ""}
                            {albumInfo?.date ? ` · ${albumInfo.date}` : ""}
                        </div>
                    </div>
                </div>
            </div>

            <PlayAllBar
                count={viewList.length}
                onPlayAll={() => {
                    if (viewList.length) {
                        TrackPlayerSingleton.playWithReplacePlayList(
                            viewList[0],
                            viewList,
                            `album:${albumItem.platform}-${albumItem.id}`,
                        );
                    } else {
                        showToast("列表是空的");
                    }
                }}
            />

            {loading ? (
                <MusicListSkeleton showIndex={false} />
            ) : error && !musicList.length ? (
                <div className="error-tip">{error}</div>
            ) : (
                <>
                    <MusicList
                        musicList={viewList}
                        listId={`album:${albumItem.platform}-${albumItem.id}`}
                        showIndex={false}
                    />
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
