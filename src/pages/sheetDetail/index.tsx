import { cssUrl } from "@/core/utils";
import { useEffect, useMemo, useState } from "react";
import { useCurrentRoute, goBack } from "@/core/router";
import { tryPluginMethod } from "@/core/pluginUtils";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { getPlugins } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import {
    getUserSheets,
    removeMusicFromSheet,
    type IUserSheet,
    LIKES_SHEET_ID,
} from "@/core/musicSheet";
import { openAddToSheet, showToast, openPrompt, openMusicActions } from "@/core/uiAtoms";
import { deleteSheet, renameSheet, sheetsVersionAtom, likesVersionAtom } from "@/core/musicSheet";
import { useAtomValue } from "jotai";
import MusicList from "@/components/base/MusicList";
import MusicListSkeleton from "@/components/base/MusicListSkeleton";
import Cover from "@/components/base/Cover";
import { IconBack, IconMore, IconPlay } from "@/components/base/Icons";

/**
 * 歌单详情页（网易云歌单页风格，三种来源）：
 *  - params.userSheetId：用户歌单（支持移除/重命名/删除）
 *  - params.sheetItem：音源推荐歌单（getMusicSheetInfo 分页）
 */

export default function SheetDetailPage() {
    const route = useCurrentRoute();
    const userSheetId: string | undefined = route.params.userSheetId;
    const sheetItem: IMusic.IMusicSheetItemBase | undefined = route.params.sheetItem;
    const [plugins, setPlugins] = useState<any[] | null>(null);
    const sourceHash = useGlobalSource();
    const sheetsVersion = useAtomValue(sheetsVersionAtom);
    const likesVersion = useAtomValue(likesVersionAtom);
    void sheetsVersion;
    void likesVersion;

    const [userSheet, setUserSheet] = useState<IUserSheet | null>(null);
    const [remoteSheetInfo, setRemoteSheetInfo] = useState<any>(null);
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
        if (userSheetId) {
            const sheet = getUserSheets().find((it) => it.id === userSheetId) ?? null;
            setUserSheet(sheet);
            setMusicList(sheet?.musicList ?? []);
            setIsEnd(true);
            setLoading(false);
        }
    }, [userSheetId, sheetsVersion, likesVersion]);

    useEffect(() => {
        if (userSheetId || !sheetItem) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const res = await tryPluginMethod<any>(
                pickSourcePlugins(plugins ?? [], "getMusicSheetInfo", sourceHash),
                "getMusicSheetInfo",
                [sheetItem, 1],
            );
            if (cancelled) {
                return;
            }
            if (res?.data) {
                setRemoteSheetInfo(res.data.sheetItem ?? sheetItem);
                setMusicList(res.data.musicList ?? []);
                setIsEnd(!!res.data.isEnd || !(res.data.musicList ?? []).length);
            } else {
                setRemoteSheetInfo(sheetItem);
                setMusicList([]);
                setIsEnd(true);
                setError("歌单加载失败，试试切换音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userSheetId, sheetItem, plugins, sourceHash]);

    const loadMore = async () => {
        if (!sheetItem || loadingMore || isEnd) {
            return;
        }
        setLoadingMore(true);
        const next = page + 1;
        const res = await tryPluginMethod<any>(
            pickSourcePlugins(plugins ?? [], "getMusicSheetInfo", sourceHash),
            "getMusicSheetInfo",
            [sheetItem, next],
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

    const info = userSheet ?? remoteSheetInfo;
    const subtitle = useMemo(() => {
        if (userSheet) {
            return `共 ${userSheet.musicList.length} 首`;
        }
        if (info?.worksNum) {
            return `共 ${info.worksNum} 首`;
        }
        return (info as any)?.creator ?? "";
    }, [userSheet, info]);

    if (!userSheetId && !sheetItem) {
        return <div className="empty-tip">歌单不存在</div>;
    }

    const listId = userSheetId
        ? `usersheet:${userSheetId}`
        : `sheet:${sheetItem?.platform}-${sheetItem?.id}`;

    const playAll = () => {
        if (musicList.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                TrackPlayerSingleton.pickPlayAllStart(musicList),
                musicList,
                listId,
            );
        } else {
            showToast("列表是空的");
        }
    };

    return (
        <div className="page" style={{ padding: 0 }}>
            <div className="detail-hero">
                <div
                    className="detail-hero-bg"
                    style={{
                        backgroundImage: cssUrl(info?.artwork),
                    }}
                />
                <div className="sub-header" style={{ background: "transparent" }}>
                    <button className="icon-btn" style={{ color: "#fff" }} onClick={() => goBack()}>
                        <IconBack size={22} />
                    </button>
                    <span className="sub-header-title" style={{ color: "#fff" }}>
                        歌单
                    </span>
                    {!!userSheetId && (
                        <button
                            className="icon-btn"
                            style={{ color: "#fff" }}
                            onClick={() => {
                                if (!userSheet) {
                                    return;
                                }
                                if (userSheet.id === LIKES_SHEET_ID) {
                                    showToast("「我喜欢的音乐」是默认歌单");
                                    return;
                                }
                                openMusicActions({
                                    musicItem: { id: userSheet.id, platform: "__sheet__" } as any,
                                    title: userSheet.title,
                                    subtitle: `${userSheet.musicList.length} 首歌曲`,
                                    actions: [
                                        {
                                            label: "重命名歌单",
                                            onClick: () => {
                                                openPrompt({
                                                    title: "重命名歌单",
                                                    defaultValue: userSheet.title,
                                                    confirmText: "保存",
                                                    onConfirm: (value) => {
                                                        if (value.trim()) {
                                                            renameSheet(
                                                                userSheet.id,
                                                                value.trim(),
                                                            );
                                                        }
                                                    },
                                                });
                                            },
                                        },
                                        {
                                            label: "删除歌单",
                                            danger: true,
                                            onClick: () => {
                                                deleteSheet(userSheet.id);
                                                showToast(`已删除「${userSheet.title}」`);
                                                goBack();
                                            },
                                        },
                                    ],
                                });
                            }}
                        >
                            <IconMore size={20} />
                        </button>
                    )}
                </div>
                <div className="detail-hero-content">
                    <Cover src={info?.artwork} size={116} radius={12} fallbackSize={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="detail-hero-title">{info?.title ?? "加载中…"}</div>
                        <div className="detail-hero-meta">{subtitle}</div>
                    </div>
                </div>
            </div>

            <button className="detail-playall" onClick={playAll}>
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
                        listId={listId}
                        showIndex
                        onRemoveItem={
                            userSheetId
                                ? (item) => {
                                      removeMusicFromSheet(userSheetId, item);
                                      setUserSheet((prev) =>
                                          prev
                                              ? {
                                                    ...prev,
                                                    musicList: prev.musicList.filter(
                                                        (it) =>
                                                            !(
                                                                it.id === item.id &&
                                                                it.platform === item.platform
                                                            ),
                                                    ),
                                                }
                                              : prev,
                                      );
                                      setMusicList((prev) =>
                                          prev.filter(
                                              (it) =>
                                                  !(
                                                      it.id === item.id &&
                                                      it.platform === item.platform
                                                  ),
                                          ),
                                      );
                                  }
                                : undefined
                        }
                    />
                    {!userSheetId && !isEnd && musicList.length > 0 && (
                        <button
                            className="settings-btn"
                            style={{ margin: "12px auto", display: "block" }}
                            disabled={loadingMore}
                            onClick={loadMore}
                        >
                            {loadingMore ? "加载中…" : "加载更多"}
                        </button>
                    )}
                    {userSheetId === LIKES_SHEET_ID && !musicList.length && (
                        <div className="empty-tip">还没有喜欢的音乐
                            <br />长按或点歌曲右侧的红心把它收进来
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
