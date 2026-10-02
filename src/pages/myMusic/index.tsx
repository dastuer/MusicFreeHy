import { useAtomValue } from "jotai";
import {
    getUserSheets,
    createSheet,
    deleteSheet,
    renameSheet,
    sheetsVersionAtom,
    LIKES_SHEET_ID,
} from "@/core/musicSheet";
import { getMusicHistory } from "@/core/musicHistory";
import { getDownloadedMusicList, downloadsVersionAtom } from "@/core/musicDownload";
import {
    getLocalMusicCount,
    localMusicVersionAtom,
} from "@/core/localMusic";
import { navigate } from "@/core/router";
import { openPrompt, openMusicActions, openDrawer, showToast } from "@/core/uiAtoms";
import Cover from "@/components/base/Cover";
import {
    IconPlus,
    IconMore,
    IconMenu,
    IconHistory,
    IconDownload,
    IconFolderMusic,
    IconHeart,
    IconListMusic,
    IconChevronRight,
    IconPlay,
    IconSearch,
} from "@/components/base/Icons";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/** 我的页：我的歌单（含我喜欢的音乐）/ 本地音乐 / 播放历史 / 设置；音源、插件等低频入口收进左上角侧边栏 */
export default function MyMusicPage() {
    const sheetsVersion = useAtomValue(sheetsVersionAtom);
    const downloadsVersion = useAtomValue(downloadsVersionAtom);
    const localVersion = useAtomValue(localMusicVersionAtom);
    void sheetsVersion;
    void downloadsVersion;
    void localVersion;
    const sheets = getUserSheets();
    const likesSheet = sheets.find((it) => it.id === LIKES_SHEET_ID);
    const userSheets = sheets.filter((it) => it.id !== LIKES_SHEET_ID);
    const historyCount = getMusicHistory().length;
    const downloadsCount = getDownloadedMusicList().length;
    const localCount = getLocalMusicCount();

    const onCreateSheet = () => {
        openPrompt({
            title: "新建歌单",
            placeholder: "输入歌单名称",
            confirmText: "创建",
            onConfirm: (value) => {
                const title = value.trim();
                if (!title) {
                    showToast("歌单名不能为空");
                    return;
                }
                createSheet(title);
                showToast(`已创建「${title}」`);
            },
        });
    };

    return (
        <div className="page">
            <div className="mine-topbar">
                <button className="icon-btn" onClick={() => openDrawer()}>
                    <IconMenu size={22} />
                </button>
                <div className="mine-search" onClick={() => navigate("search")}>
                    <IconSearch size={16} />
                    <span>搜索音乐</span>
                </div>
            </div>

            <div className="mine-list">
                <div className="mine-row" onClick={() => navigate("downloads")}>
                    <span className="m-icon">
                        <IconDownload size={21} />
                    </span>
                    <span className="mine-row-label">我的下载</span>
                    <span className="mine-row-extra">{downloadsCount || ""}</span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
                <div className="mine-row" onClick={() => navigate("localMusic")}>
                    <span className="m-icon">
                        <IconFolderMusic size={21} />
                    </span>
                    <span className="mine-row-label">本地音乐</span>
                    <span className="mine-row-extra">{localCount || ""}</span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
                <div className="mine-row" onClick={() => navigate("history")}>
                    <span className="m-icon">
                        <IconHistory size={21} />
                    </span>
                    <span className="mine-row-label">播放历史</span>
                    <span className="mine-row-extra">{historyCount || ""}</span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
            </div>

            <div className="section-title" style={{ paddingTop: 10 }}>
                我的歌单 ({sheets.length})
                <span className="section-more" onClick={onCreateSheet}>
                    <IconPlus size={12} />
                    新建
                </span>
            </div>

            <div className="mine-list">
                <div
                    className="mine-sheet-row"
                    onClick={() => navigate("sheetDetail", { userSheetId: LIKES_SHEET_ID })}
                >
                    {likesSheet?.musicList?.[0]?.artwork ? (
                        <Cover
                            src={likesSheet.musicList[0].artwork}
                            size={50}
                            radius={9}
                        />
                    ) : (
                        <div className="mine-likes-cover">
                            <IconHeart size={22} filled />
                        </div>
                    )}
                    <div className="mine-sheet-info">
                        <div className="mine-sheet-title">我喜欢的音乐</div>
                        <div className="mine-sheet-sub">
                            {likesSheet?.musicList.length ?? 0} 首
                        </div>
                    </div>
                    <button
                        className="icon-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            const list = likesSheet?.musicList ?? [];
                            if (list.length) {
                                TrackPlayerSingleton.playWithReplacePlayList(
                                    list[0],
                                    list,
                                    "my-likes",
                                );
                            } else {
                                showToast("喜欢的音乐还是空的");
                            }
                        }}
                    >
                        <IconPlay size={18} />
                    </button>
                </div>
                {userSheets.map((sheet) => (
                    <div
                        key={sheet.id}
                        className="mine-sheet-row"
                        onClick={() => navigate("sheetDetail", { userSheetId: sheet.id })}
                    >
                        <Cover src={sheet.musicList?.[0]?.artwork} size={50} radius={9}>
                            {!sheet.musicList?.length && (
                                <span style={{ color: "var(--text-placeholder)" }}>
                                    <IconListMusic size={20} />
                                </span>
                            )}
                        </Cover>
                        <div className="mine-sheet-info">
                            <div className="mine-sheet-title">{sheet.title}</div>
                            <div className="mine-sheet-sub">
                                {sheet.musicList?.length ?? 0} 首
                            </div>
                        </div>
                        <button
                            className="icon-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                openMusicActions({
                                    musicItem: { id: sheet.id, platform: "__sheet__" } as any,
                                    title: sheet.title,
                                    subtitle: `${sheet.musicList?.length ?? 0} 首歌曲`,
                                    actions: [
                                        {
                                            label: "重命名歌单",
                                            onClick: () => {
                                                openPrompt({
                                                    title: "重命名歌单",
                                                    defaultValue: sheet.title,
                                                    confirmText: "保存",
                                                    onConfirm: (value) => {
                                                        if (value.trim()) {
                                                            renameSheet(
                                                                sheet.id,
                                                                value.trim(),
                                                            );
                                                        }
                                                    },
                                                });
                                            },
                                        },
                                        {
                                            label: "播放歌单",
                                            onClick: () => {
                                                if (sheet.musicList?.length) {
                                                    TrackPlayerSingleton.playWithReplacePlayList(
                                                        sheet.musicList[0],
                                                        sheet.musicList,
                                                        sheet.id,
                                                    );
                                                } else {
                                                    showToast("歌单是空的");
                                                }
                                            },
                                        },
                                        {
                                            label: "删除歌单",
                                            danger: true,
                                            onClick: () => {
                                                deleteSheet(sheet.id);
                                                showToast(`已删除「${sheet.title}」`);
                                            },
                                        },
                                    ],
                                });
                            }}
                        >
                            <IconMore size={18} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
