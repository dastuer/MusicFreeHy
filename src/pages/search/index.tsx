import { useCallback, useEffect, useState } from "react";
import { useCurrentRoute, goBack, navigate } from "@/core/router";
import { getPlugins, pluginCall, type SerializedPlugin } from "@/core/ipc";
import {
    pickSourcePlugins,
    useGlobalSource,
    setGlobalSource,
    getDefaultPluginHash,
    AUTO_SOURCE,
} from "@/core/mediaSource";
import {
    addSearchHistory,
    getSearchHistory,
    removeSearchHistory,
    clearSearchHistory,
} from "@/core/searchHistory";
import MusicList from "@/components/base/MusicList";
import MusicListSkeleton from "@/components/base/MusicListSkeleton";
import Spinner from "@/components/base/Spinner";
import Cover from "@/components/base/Cover";
import { IconBack, IconClose, IconSearch } from "@/components/base/Icons";
import { formatPlayCount } from "@/core/utils";

/**
 * 搜索页：单曲/歌单/专辑/歌手 四类结果，插件音源切换，搜索历史。
 */

type SearchType = "music" | "sheet" | "album" | "artist";

const TYPE_TABS: { key: SearchType; label: string }[] = [
    { key: "music", label: "单曲" },
    { key: "sheet", label: "歌单" },
    { key: "album", label: "专辑" },
    { key: "artist", label: "歌手" },
];

function dedupe<T extends { id?: string | number; platform?: string }>(prev: T[], data: T[]): T[] {
    const seen = new Set(prev.map((it) => `${it.platform}-${it.id}`));
    return [...prev, ...data.filter((it) => !seen.has(`${it.platform}-${it.id}`))];
}

export default function SearchPage() {
    const route = useCurrentRoute();
    const routeKeyword: string = route.params.keyword ?? "";
    const [input, setInput] = useState(routeKeyword);
    const [keyword, setKeyword] = useState(routeKeyword);
    const [plugins, setPlugins] = useState<SerializedPlugin[] | null>(null);
    const sourceHash = useGlobalSource();
    const [type, setType] = useState<SearchType>("music");
    const [history, setHistory] = useState(getSearchHistory());

    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [sheets, setSheets] = useState<IMusic.IMusicSheetItemBase[]>([]);
    const [albums, setAlbums] = useState<IAlbum.IAlbumItemBase[]>([]);
    const [artists, setArtists] = useState<IArtist.IArtistItemBase[]>([]);
    const [isEnd, setIsEnd] = useState(false);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    const doSearch = useCallback(
        async (kw: string, searchType: SearchType, pageNum: number, replace: boolean) => {
            if (!kw || !plugins) {
                return;
            }
            replace ? setLoading(true) : setLoadingMore(true);
            setError(null);
            const candidates = pickSourcePlugins(plugins, "search", sourceHash);
            let got = false;
            for (const plugin of candidates) {
                try {
                    const res = await pluginCall<any>(plugin.hash, "search", kw, pageNum, searchType);
                    const data = (res?.data ?? []) as any[];
                    if (searchType === "music") {
                        setMusicList((prev) => (replace ? data : dedupe(prev, data)));
                    } else if (searchType === "sheet") {
                        setSheets((prev) => (replace ? data : dedupe(prev, data)));
                    } else if (searchType === "album") {
                        setAlbums((prev) => (replace ? data : dedupe(prev, data)));
                    } else {
                        setArtists((prev) => (replace ? data : dedupe(prev, data)));
                    }
                    setIsEnd(!!res?.isEnd || !data.length);
                    got = true;
                    break;
                } catch {
                    continue;
                }
            }
            if (!got && replace) {
                if (searchType === "music") {
                    setMusicList([]);
                } else if (searchType === "sheet") {
                    setSheets([]);
                } else if (searchType === "album") {
                    setAlbums([]);
                } else {
                    setArtists([]);
                }
                setIsEnd(true);
                setError(candidates.length ? "搜索失败，试试切换音源" : "没有可用音源，先安装插件吧");
            } else if (!got) {
                setIsEnd(true);
            }
            setLoading(false);
            setLoadingMore(false);
        },
        [plugins, sourceHash],
    );

    const submit = (kw: string) => {
        const trimmed = kw.trim();
        if (!trimmed) {
            return;
        }
        setInput(trimmed);
        setKeyword(trimmed);
        setHistory(addSearchHistory(trimmed));
    };

    // 关键词 / 类型 / 音源变化：重搜
    useEffect(() => {
        if (!keyword) {
            return;
        }
        setPage(1);
        doSearch(keyword, type, 1, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keyword, type, sourceHash, plugins]);

    const loadMore = () => {
        if (!keyword || isEnd || loading || loadingMore) {
            return;
        }
        const next = page + 1;
        setPage(next);
        doSearch(keyword, type, next, false);
    };

    const resultCount =
        type === "music" ? musicList.length : type === "sheet" ? sheets.length : type === "album" ? albums.length : artists.length;

    return (
        <div
            className="page"
            onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
                    loadMore();
                }
            }}
        >
            <div className="search-bar">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <div className="search-input-wrap">
                    <IconSearch size={16} />
                    <input
                        value={input}
                        placeholder="搜索歌曲、歌单、专辑、歌手"
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                                submit(input);
                            }
                        }}
                        enterKeyHint="search"
                    />
                    {input && (
                        <button className="icon-btn" onClick={() => setInput("")}>
                            <IconClose size={14} />
                        </button>
                    )}
                </div>
                <button
                    style={{ color: "var(--text-secondary)", fontSize: 14 }}
                    onClick={() => submit(input)}
                >
                    搜索
                </button>
            </div>

            {/* 音源选择 chips：与全局音源联动 */}
            <div className="search-chips">
                <span
                    className={`chip ${sourceHash === AUTO_SOURCE ? "active" : ""}`}
                    onClick={() => setGlobalSource(AUTO_SOURCE)}
                >
                    {getDefaultPluginHash() ? "默认音源" : "自动"}
                </span>
                {(plugins ?? [])
                    .filter((p) => p.enabled && p.state === "Mounted" && p.supportedMethods.includes("search"))
                    .map((p) => (
                        <span
                            key={p.hash}
                            className={`chip ${sourceHash === p.hash ? "active" : ""}`}
                            onClick={() => setGlobalSource(p.hash)}
                        >
                            {p.name}
                        </span>
                    ))}
            </div>

            {!keyword ? (
                <>
                    {history.length > 0 && (
                        <>
                            <div className="section-title" style={{ padding: "8px 16px 10px" }}>
                                搜索历史
                                <span
                                    className="section-more"
                                    onClick={() => setHistory(clearSearchHistory())}
                                >
                                    清空
                                </span>
                            </div>
                            <div className="history-chips">
                                {history.map((kw) => (
                                    <span key={kw} className="chip" onClick={() => submit(kw)}>
                                        {kw}
                                        <button
                                            className="icon-btn"
                                            style={{ padding: 0, marginLeft: 4 }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setHistory(removeSearchHistory(kw));
                                            }}
                                        >
                                            <IconClose size={11} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        </>
                    )}
                    <div className="empty-tip" style={{ paddingTop: 80 }}>
                        输入关键词开始搜索
                        <br />
                        支持安装的音源插件直接搜歌
                    </div>
                </>
            ) : (
                <>
                    <div className="search-tabs">
                        {TYPE_TABS.map((t) => (
                            <span
                                key={t.key}
                                className={`search-tab ${type === t.key ? "active" : ""}`}
                                onClick={() => setType(t.key)}
                            >
                                {t.label}
                            </span>
                        ))}
                    </div>
                    {error && <div className="error-tip">{error}</div>}
                    {loading ? (
                        type === "music" ? (
                            <MusicListSkeleton showIndex={false} />
                        ) : (
                            <div className="loading-tip loading-spin" style={{ paddingTop: 40 }}>
                                <Spinner size={20} />
                                搜索中…
                            </div>
                        )
                    ) : (
                        <>
                            {type === "music" && (
                                <MusicList musicList={musicList} listId={`search:${keyword}`} showIndex={false} />
                            )}
                            {type === "sheet" &&
                                sheets.map((it) => (
                                    <div
                                        key={`${it.platform}-${it.id}`}
                                        className="song-row"
                                        onClick={() => navigate("sheetDetail", { sheetItem: it })}
                                    >
                                        <Cover src={it.artwork} size={50} radius={9} />
                                        <div className="song-row-info">
                                            <div className="song-row-title">{it.title}</div>
                                            <div className="song-row-sub">
                                                {it.creator ?? it.description ?? "歌单"}
                                                {it.playCount ? ` · ${formatPlayCount(it.playCount)}次播放` : ""}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            {type === "album" &&
                                albums.map((it) => (
                                    <div
                                        key={`${it.platform}-${it.id}`}
                                        className="song-row"
                                        onClick={() => navigate("albumDetail", { albumItem: it })}
                                    >
                                        <Cover src={it.artwork} size={50} radius={9} />
                                        <div className="song-row-info">
                                            <div className="song-row-title">{it.title}</div>
                                            <div className="song-row-sub">
                                                专辑{it.artist ? ` · ${it.artist}` : ""}
                                                {it.date ? ` · ${it.date}` : ""}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            {type === "artist" &&
                                artists.map((it) => (
                                    <div
                                        key={`${it.platform}-${it.id}`}
                                        className="song-row"
                                        onClick={() => navigate("artistDetail", { artistItem: it })}
                                    >
                                        <Cover src={it.avatar ?? it.artwork} size={50} radius={25} />
                                        <div className="song-row-info">
                                            <div className="song-row-title">{it.name}</div>
                                            <div className="song-row-sub">
                                                歌手
                                                {it.worksNum ? ` · ${it.worksNum} 个作品` : ""}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            {!resultCount && !error && !loading && (
                                <div className="empty-tip">没有找到相关内容</div>
                            )}
                            {loadingMore && <div className="loading-tip">加载更多…</div>}
                            {isEnd && resultCount > 6 && !loadingMore && (
                                <div className="loading-tip">没有更多了</div>
                            )}
                        </>
                    )}
                </>
            )}
        </div>
    );
}
