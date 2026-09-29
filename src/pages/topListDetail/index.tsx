import { cssUrl } from "@/core/utils";
import { useEffect, useState } from "react";
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

    if (!topListItem) {
        return <div className="empty-tip">榜单不存在</div>;
    }

    return (
        <div className="page" style={{ padding: 0 }}>
            <div className="detail-hero">
                <div
                    className="detail-hero-bg"
                    style={{
                        backgroundImage: cssUrl(topListItem.artwork),
                    }}
                />
                <div className="sub-header" style={{ background: "transparent" }}>
                    <button className="icon-btn" style={{ color: "#fff" }} onClick={() => goBack()}>
                        <IconBack size={22} />
                    </button>
                    <span className="sub-header-title" style={{ color: "#fff" }}>
                        排行榜
                    </span>
                </div>
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

            <button
                className="detail-playall"
                onClick={() => {
                    if (musicList.length) {
                        TrackPlayerSingleton.playWithReplacePlayList(
                            musicList[0],
                            musicList,
                            `toplist:${topListItem.platform}-${topListItem.id}`,
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
                <MusicListSkeleton />
            ) : error && !musicList.length ? (
                <div className="error-tip">{error}</div>
            ) : (
                <>
                    <MusicList
                        musicList={musicList}
                        listId={`toplist:${topListItem.platform}-${topListItem.id}`}
                        showIndex
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
