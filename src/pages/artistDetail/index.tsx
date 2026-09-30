import { useEffect, useRef, useState } from "react";
import { useCurrentRoute, goBack, navigate } from "@/core/router";
import { tryPluginMethod } from "@/core/pluginUtils";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { getPlugins } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import MusicList from "@/components/base/MusicList";
import AutoLoadMore from "@/components/base/AutoLoadMore";
import MusicListSkeleton from "@/components/base/MusicListSkeleton";
import Spinner from "@/components/base/Spinner";
import Cover from "@/components/base/Cover";
import { IconBack } from "@/components/base/Icons";
import PlayAllBar from "@/components/base/PlayAllBar";
import { showToast } from "@/core/uiAtoms";
import { formatPlayCount , cssUrl } from "@/core/utils";
import { IconHeadphone } from "@/components/base/Icons";

/** 歌手详情页：getArtistWorks（单曲 / 专辑两个标签） */

export default function ArtistDetailPage() {
    const route = useCurrentRoute();
    const artistItem: IArtist.IArtistItemBase | undefined = route.params.artistItem;
    const [plugins, setPlugins] = useState<any[] | null>(null);
    const sourceHash = useGlobalSource();
    const [worksType, setWorksType] = useState<"music" | "album">("music");
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [albums, setAlbums] = useState<IAlbum.IAlbumItemBase[]>([]);
    const [isEnd, setIsEnd] = useState(false);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 吸顶顶栏：滚过 hero 后变实底并显示歌手名
    const topbarRef = useRef<HTMLDivElement | null>(null);
    const heroRef = useRef<HTMLDivElement | null>(null);
    const [topSolid, setTopSolid] = useState(false);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!artistItem) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        setMusicList([]);
        setAlbums([]);
        setIsEnd(false);
        setPage(1);
        (async () => {
            const res = await tryPluginMethod<any>(
                pickSourcePlugins(plugins ?? [], "getArtistWorks", sourceHash),
                "getArtistWorks",
                [artistItem, 1, worksType],
            );
            if (cancelled) {
                return;
            }
            if (res?.data) {
                const data = res.data.data ?? [];
                if (worksType === "music") {
                    setMusicList(data);
                } else {
                    setAlbums(data);
                }
                setIsEnd(!!res.data.isEnd || !data.length);
            } else {
                setIsEnd(true);
                setError("加载失败，试试切换音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artistItem, plugins, sourceHash, worksType]);

    const loadMore = async () => {
        if (!artistItem || loadingMore || isEnd) {
            return;
        }
        setLoadingMore(true);
        const next = page + 1;
        const res = await tryPluginMethod<any>(
            pickSourcePlugins(plugins ?? [], "getArtistWorks", sourceHash),
            "getArtistWorks",
            [artistItem, next, worksType],
        );
        if (res?.data?.data?.length) {
            const data = res.data.data as any[];
            if (worksType === "music") {
                setMusicList((prev) => {
                    const seen = new Set(prev.map((it) => `${it.platform}-${it.id}`));
                    return [...prev, ...data.filter((it) => !seen.has(`${it.platform}-${it.id}`))];
                });
            } else {
                setAlbums((prev) => {
                    const seen = new Set(prev.map((it) => `${it.platform}-${it.id}`));
                    return [...prev, ...data.filter((it) => !seen.has(`${it.platform}-${it.id}`))];
                });
            }
            setIsEnd(!!res.data.isEnd);
            setPage(next);
        } else {
            setIsEnd(true);
        }
        setLoadingMore(false);
    };

    if (!artistItem) {
        return <div className="empty-tip">歌手不存在</div>;
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
                    {topSolid ? (artistItem?.name ?? "歌手") : "歌手"}
                </span>
            </div>
            <div className="detail-hero" ref={heroRef}>
                <div
                    className="detail-hero-bg"
                    style={{
                        backgroundImage: cssUrl(artistItem.avatar ?? artistItem.artwork),
                    }}
                />
                <div className="detail-hero-content">
                    <Cover
                        src={artistItem.avatar ?? artistItem.artwork}
                        size={96}
                        radius={48}
                        fallbackSize={40}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="detail-hero-title">{artistItem.name}</div>
                        {artistItem.worksNum ? (
                            <div className="detail-hero-meta">{artistItem.worksNum} 个作品</div>
                        ) : null}
                    </div>
                </div>
            </div>

            <div className="search-tabs" style={{ padding: "14px 16px 6px" }}>
                <span
                    className={`search-tab ${worksType === "music" ? "active" : ""}`}
                    onClick={() => setWorksType("music")}
                >
                    单曲
                </span>
                <span
                    className={`search-tab ${worksType === "album" ? "active" : ""}`}
                    onClick={() => setWorksType("album")}
                >
                    专辑
                </span>
            </div>

            {worksType === "music" && (
                <PlayAllBar
                    count={musicList.length}
                    onPlayAll={() => {
                        if (musicList.length) {
                            TrackPlayerSingleton.playWithReplacePlayList(
                                musicList[0],
                                musicList,
                                `artist:${artistItem.platform}-${artistItem.id}:music`,
                            );
                        } else {
                            showToast("列表是空的");
                        }
                    }}
                />
            )}

            {loading ? (
                worksType === "album" ? (
                    <div className="loading-tip loading-spin" style={{ paddingTop: 60 }}>
                        <Spinner size={20} />
                        加载中…
                    </div>
                ) : (
                    <MusicListSkeleton showIndex={false} />
                )
            ) : error && !musicList.length && !albums.length ? (
                <div className="error-tip">{error}</div>
            ) : (
                <>
                    {worksType === "music" && (
                        <MusicList
                            musicList={musicList}
                            listId={`artist:${artistItem.platform}-${artistItem.id}:music`}
                            showIndex={false}
                        />
                    )}
                    {worksType === "album" && (
                        <div className="sheet-grid">
                            {albums.map((it) => (
                                <div
                                    key={`${it.platform}-${it.id}`}
                                    className="sheet-card-h"
                                    onClick={() => navigate("albumDetail", { albumItem: it })}
                                >
                                    <Cover src={it.artwork} radius={12} className="sheet-grid-cover">
                                        <span className="card-playcount">
                                            <IconHeadphone size={11} />
                                            {formatPlayCount(it.worksNum)}
                                        </span>
                                    </Cover>
                                    <div className="card-title">{it.title}</div>
                                    <div
                                        style={{
                                            fontSize: 11,
                                            color: "var(--text-tertiary)",
                                            marginTop: -2,
                                        }}
                                    >
                                        {it.date ?? ""}
                                    </div>
                                </div>
                            ))}
                            {!albums.length && <div className="empty-tip">没有找到专辑</div>}
                        </div>
                    )}
                    <AutoLoadMore
                        onLoadMore={loadMore}
                        loadingMore={loadingMore}
                        hasMore={!isEnd && (musicList.length > 0 || albums.length > 0)}
                        itemsLength={worksType === "music" ? musicList.length : albums.length}
                        showEndTip={
                            (worksType === "music" ? musicList.length : albums.length) > 6
                        }
                    />
                </>
            )}
        </div>
    );
}
