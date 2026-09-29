import { cssUrl } from "@/core/utils";
import { useEffect, useRef, useState } from "react";
import { useCurrentRoute, goBack } from "@/core/router";
import { tryPluginMethod } from "@/core/pluginUtils";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { getPlugins } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import MusicList from "@/components/base/MusicList";
import MusicListSkeleton from "@/components/base/MusicListSkeleton";
import Cover from "@/components/base/Cover";
import { IconBack, IconPlay } from "@/components/base/Icons";
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
                className={`sub-header detail-topbar${topSolid ? " solid" : ""}`}
                ref={topbarRef}
            >
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">
                    {topSolid ? (albumInfo?.title ?? "专辑") : "专辑"}
                </span>
            </div>
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

            <button
                className="detail-playall"
                onClick={() => {
                    if (musicList.length) {
                        TrackPlayerSingleton.playWithReplacePlayList(
                            musicList[0],
                            musicList,
                            `album:${albumItem.platform}-${albumItem.id}`,
                        );
                    } else {
                        showToast("列表是空的");
                    }
                }}
            >
                <IconPlay size={18} />
                播放全部
                <span className="pa-sub">({musicList.length})</span>
            </button>

            {loading ? (
                <MusicListSkeleton showIndex={false} />
            ) : error && !musicList.length ? (
                <div className="error-tip">{error}</div>
            ) : (
                <>
                    <MusicList
                        musicList={musicList}
                        listId={`album:${albumItem.platform}-${albumItem.id}`}
                        showIndex={false}
                    />
                    {!isEnd && musicList.length > 0 && (
                        <button
                            className="settings-btn"
                            style={{ margin: "12px auto", display: "block" }}
                            disabled={loadingMore}
                            onClick={loadMore}
                        >
                            {loadingMore ? "加载中…" : "加载更多"}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
