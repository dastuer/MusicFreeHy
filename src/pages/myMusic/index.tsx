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
import { navigate } from "@/core/router";
import {
    openPrompt,
    openMusicActions,
    openSourceSelect,
    showToast,
} from "@/core/uiAtoms";
import {
    useGlobalSource,
    useUsablePlugins,
    useDefaultPluginHash,
    getSourceDisplayName,
} from "@/core/mediaSource";
import Cover from "@/components/base/Cover";
import {
    IconPlus,
    IconMore,
    IconHistory,
    IconPuzzle,
    IconSettings,
    IconHeart,
    IconListMusic,
    IconChevronRight,
    IconPlay,
    IconDisc,
} from "@/components/base/Icons";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/** 我的页：喜欢的音乐 / 我的歌单 / 历史 / 音源选择 / 插件 / 设置 */
export default function MyMusicPage() {
    const sheetsVersion = useAtomValue(sheetsVersionAtom);
    void sheetsVersion;
    const sheets = getUserSheets();
    const likesSheet = sheets.find((it) => it.id === LIKES_SHEET_ID);
    const userSheets = sheets.filter((it) => it.id !== LIKES_SHEET_ID);
    const historyCount = getMusicHistory().length;
    const sourceHash = useGlobalSource();
    const defaultHash = useDefaultPluginHash();
    const usablePlugins = useUsablePlugins();

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
            {/* 我喜欢的音乐 */}
            <div
                className="mine-likes"
                onClick={() => navigate("sheetDetail", { userSheetId: LIKES_SHEET_ID })}
            >
                <div className="mine-likes-cover">
                    <IconHeart size={26} filled />
                </div>
                <div style={{ flex: 1 }}>
                    <div className="mine-likes-title">我喜欢的音乐</div>
                    <div className="mine-likes-sub">{likesSheet?.musicList.length ?? 0} 首</div>
                </div>
                <button
                    className="mini-btn mini-play-btn"
                    style={{ borderColor: "var(--text-tertiary)" }}
                    onClick={(e) => {
                        e.stopPropagation();
                        const list = likesSheet?.musicList ?? [];
                        if (list.length) {
                            TrackPlayerSingleton.playWithReplacePlayList(list[0], list, "my-likes");
                        } else {
                            showToast("喜欢的音乐还是空的");
                        }
                    }}
                >
                    <IconPlay size={18} />
                </button>
            </div>

            <div className="mine-list">
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
                <div className="mine-row" onClick={openSourceSelect}>
                    <span className="m-icon">
                        <IconDisc size={21} />
                    </span>
                    <span className="mine-row-label">音源选择</span>
                    <span className="mine-row-extra">
                        {getSourceDisplayName(usablePlugins, sourceHash, defaultHash)}
                    </span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
                <div className="mine-row" onClick={() => navigate("pluginManage")}>
                    <span className="m-icon">
                        <IconPuzzle size={21} />
                    </span>
                    <span className="mine-row-label">插件管理</span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
                <div className="mine-row" onClick={() => navigate("settings")}>
                    <span className="m-icon">
                        <IconSettings size={21} />
                    </span>
                    <span className="mine-row-label">设置</span>
                    <span className="chevron">
                        <IconChevronRight size={18} />
                    </span>
                </div>
            </div>

            <div className="section-title" style={{ paddingTop: 10 }}>
                创建的歌单 ({userSheets.length})
                <span className="section-more" onClick={onCreateSheet}>
                    <IconPlus size={12} />
                    新建
                </span>
            </div>

            <div className="mine-list">
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
                            <div className="mine-sheet-sub">{sheet.musicList?.length ?? 0} 首</div>
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
                                                            renameSheet(sheet.id, value.trim());
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
                {!userSheets.length && (
                    <div
                        className="mine-row"
                        style={{ color: "var(--text-tertiary)", fontSize: 13 }}
                        onClick={onCreateSheet}
                    >
                        <span className="m-icon">
                            <IconPlus size={19} />
                        </span>
                        新建歌单，把喜欢的歌归归类
                    </div>
                )}
            </div>
        </div>
    );
}
