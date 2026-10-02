import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { goBack, navigate } from "@/core/router";
import {
    getLocalMusicList,
    getEffectiveScanDirs,
    isScanDirsDefault,
    isSkipShortEnabled,
    setCustomScanDirs,
    setSkipShortEnabled,
    localMusicPlatform,
    localMusicVersionAtom,
    removeLocalMusic,
    requestAudioPermission,
    scanDirLabel,
    scanLocalMusic,
    toMusicItem,
    formatFileSize,
    isMatchRunning,
    matchTaskAtom,
    pauseLocalMatch,
    resumeLocalMatch,
    startLocalMatch,
    stopLocalMatch,
    SHORT_AUDIO_SECONDS,
    type ILocalMusicRecord,
    type IScanDir,
} from "@/core/localMusic";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { openAddToSheet, openMusicActions, openSingleSelect, showToast } from "@/core/uiAtoms";
import { addMusicToSheetMany, LIKES_SHEET_ID } from "@/core/musicSheet";
import { useBackLayer } from "@/core/systemBack";
import { formatSeconds } from "@/core/utils";
import { getSortedSearchablePlugins, type SerializedPlugin } from "@/core/ipc";
import { localFileUrl } from "@/core/native";
import Cover from "@/components/base/Cover";
import MusicList from "@/components/base/MusicList";
import PlayAllBar from "@/components/base/PlayAllBar";
import SelectActionsBar from "@/components/base/SelectActionsBar";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useListSearch } from "@/hooks/useListSearch";
import {
    IconBack,
    IconChevronRight,
    IconClose,
    IconFolderMusic,
    IconFolderPlus,
    IconMore,
    IconMusic,
    IconPause,
    IconPlay,
    IconSearch,
    IconStop,
    IconTrash,
} from "@/components/base/Icons";

function formatDateTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "未知";
    }
    const d = new Date(seconds * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
        d.getMinutes(),
    )}`;
}

function baseName(path: string): string {
    const at = path.lastIndexOf("/");
    return at >= 0 ? path.slice(at + 1) : path;
}

/**
 * 匹配进度条（参考网易云「获取图词」）：可暂停 / 继续 / 停止。
 * 单独订阅 matchTaskAtom —— 「正在匹配」的曲目名每首都变，隔离在这里，
 * 避免匹配期间整页（含 500+ 行的音乐列表）跟着每首歌重渲染一次。
 */
function LocalMatchBar() {
    const matchTask = useAtomValue(matchTaskAtom);
    if (!matchTask) {
        return null;
    }
    return (
        <div className="lm-match-bar">
            <div className="lm-match-line">
                <span className="lm-match-text">
                    {matchTask.status === "paused" ? "匹配已暂停" : "正在匹配歌词与封面"}
                    <b>
                        {" "}
                        {matchTask.done}/{matchTask.total}
                    </b>
                </span>
                <div className="lm-match-btns">
                    {matchTask.status === "paused" ? (
                        <button className="lm-match-btn" onClick={resumeLocalMatch}>
                            <IconPlay size={13} />
                            继续
                        </button>
                    ) : (
                        <button className="lm-match-btn" onClick={pauseLocalMatch}>
                            <IconPause size={13} />
                            暂停
                        </button>
                    )}
                    <button className="lm-match-btn" onClick={stopLocalMatch}>
                        <IconStop size={13} />
                        停止
                    </button>
                </div>
            </div>
            {matchTask.status === "running" && matchTask.current && (
                <div className="lm-match-current">{matchTask.current}</div>
            )}
            <div className="lm-match-progress">
                <span
                    style={{
                        width: `${
                            matchTask.total
                                ? Math.round((matchTask.done / matchTask.total) * 100)
                                : 0
                        }%`,
                    }}
                />
            </div>
        </div>
    );
}

/** 「本地音乐」页：本地曲库管理（播放全部 / 喜欢 / 收藏 / 删除 / 多选 / 扫描 / 详情） */
export default function LocalMusicPage() {
    // 订阅曲库版本号驱动派生数据重算（匹配期间每 1.2s 自增一次）；
    // version 不能拼进 MusicList 的 listId，否则渐进渲染窗口会被不断重置回前 150 行
    const version = useAtomValue(localMusicVersionAtom);
    const platform = localMusicPlatform();
    // getLocalMusicList 走内存缓存（旧实现每次全量 JSON.parse，是页面卡顿的主因）
    const records = getLocalMusicList();
    // 派生数据只在曲库版本变化时重算；匹配循环原地改缓存里的条目，
    // 数组引用不变，所以依赖里必须带上 version
    const musicList = useMemo(() => records.map(toMusicItem), [records, version]);
    const recordById = useMemo(
        () => new Map(records.map((it) => [it.localPath, it])),
        [records, version],
    );

    /* 局部搜索：过滤仅作用于列表视图与播放全部 */
    const search = useListSearch(musicList);
    const viewList = search.active ? search.filtered : musicList;

    /* 多选（收藏 / 喜欢 / 删除） */
    const [selectMode, setSelectMode] = useState(false);
    const [picked, setPicked] = useState<IMusic.IMusicItem[]>([]);
    // recordById 的键就是 localPath（= 本地条目的 id），O(1) 判断替代逐条扫全表
    const selected = picked.filter((it) => it.platform === "local" && recordById.has(it.id));
    const selectedKeys = new Set(selected.map((it) => `${it.platform}-${it.id}`));

    const enterSelect = () => {
        setPicked([]);
        setSelectMode(true);
    };
    const exitSelect = () => {
        setSelectMode(false);
        setPicked([]);
    };
    const toggleSelect = (item: IMusic.IMusicItem) => {
        setPicked((prev) => {
            const idx = prev.findIndex((it) => it.platform === item.platform && it.id === item.id);
            if (idx >= 0) {
                return prev.filter((_, i) => i !== idx);
            }
            return [...prev, item];
        });
    };

    const playAll = () => {
        if (musicList.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                TrackPlayerSingleton.pickPlayAllStart(musicList),
                musicList,
                "localMusic",
            );
        } else {
            showToast("本地音乐列表是空的，先扫描一下吧");
        }
    };

    /* 删除：默认只移除记录，同时删文件需用户确认 */
    const doRemove = (targets: IMusic.IMusicItem[], deleteFiles: boolean) => {
        void removeLocalMusic(targets, deleteFiles).then((res) => {
            if (!res.removed) {
                showToast("所选歌曲不在本地音乐列表");
                return;
            }
            const parts = [`已移除 ${res.removed} 首本地音乐`];
            if (deleteFiles) {
                parts.push(
                    res.fileFailed
                        ? `${res.fileDeleted} 个文件已删除，${res.fileFailed} 个删除失败`
                        : `${res.fileDeleted} 个音频文件已删除`,
                );
            }
            showToast(parts.join("，"), 3600);
            exitSelect();
        });
    };

    const confirmRemove = (targets: IMusic.IMusicItem[]) => {
        openMusicActions({
            musicItem: { id: "__remove_local__", platform: "__remove_local__" } as any,
            title: targets.length > 1 ? `删除 ${targets.length} 首本地音乐` : "删除本地音乐",
            subtitle: "是否同时删除音频文件？删除文件后不可恢复",
            actions: [
                {
                    label: "仅移除记录（保留文件）",
                    onClick: () => doRemove(targets, false),
                },
                {
                    label: "同时删除音频文件",
                    danger: true,
                    onClick: () => doRemove(targets, true),
                },
            ],
        });
    };

    /* 详情弹窗 */
    const [detail, setDetail] = useState<ILocalMusicRecord | null>(null);

    /* 右上角更多菜单（扫描 / 匹配歌词与封面） */
    const openMoreMenu = () => {
        openMusicActions({
            musicItem: { id: "__local_more__", platform: "__local_more__" } as any,
            title: "本地音乐",
            subtitle: musicList.length ? `共 ${musicList.length} 首歌曲` : "还没有扫描过音乐",
            actions: [
                {
                    label: "扫描本地音乐",
                    onClick: () => void openScan(),
                },
                {
                    label: "匹配歌词与封面",
                    onClick: () => void openMatchSheet(),
                },
            ],
        });
    };

    /* 扫描面板 */
    const [scanOpen, setScanOpen] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [dirs, setDirs] = useState<IScanDir[]>([]);
    const [dirsDefault, setDirsDefault] = useState(true);
    const [skipShort, setSkipShort] = useState(true);

    const openScan = async () => {
        if (platform === "web") {
            showToast("本地音乐扫描请在手机 App 中使用", 3200);
            return;
        }
        setDirs(await getEffectiveScanDirs());
        setDirsDefault(isScanDirsDefault());
        setSkipShort(isSkipShortEnabled());
        setScanOpen(true);
    };

    /** 浏览文件系统勾选扫描目录（文件夹选择页多选模式），选完可直接扫描 */
    const addDir = () => {
        setScanOpen(false);
        navigate("folderSelect", { mode: "multi" });
    };

    const removeDir = async (path: string) => {
        const next = dirs.filter((d) => d.path !== path);
        setCustomScanDirs(next);
        if (next.length) {
            setDirs(next);
        } else {
            // 删空了回到默认目录模式
            setDirs(await getEffectiveScanDirs());
            setDirsDefault(true);
        }
    };

    const resetDirs = async () => {
        setCustomScanDirs([]);
        setDirs(await getEffectiveScanDirs());
        setDirsDefault(true);
        showToast("已恢复默认扫描目录");
    };

    const startScan = async () => {
        if (scanning) {
            return;
        }
        setScanning(true);
        try {
            const granted = await requestAudioPermission();
            if (!granted) {
                showToast("未授予音频读取权限，部分目录可能扫描不到", 3200);
            }
            const res = await scanLocalMusic();
            const parts = [`扫描完成：共 ${res.total} 首，新增 ${res.added} 首`];
            if (res.removed) {
                parts.push(`移除 ${res.removed} 首`);
            }
            if (res.skippedShort) {
                parts.push(`跳过 ${res.skippedShort} 个短音频`);
            }
            if (res.failedDirs.length) {
                parts.push(`${res.failedDirs.length} 个目录无法读取`);
            }
            showToast(parts.join("，"), 4200);
            setScanOpen(false);
        } catch (e: any) {
            showToast(`扫描失败：${e?.message ?? e}`, 3600);
        } finally {
            setScanning(false);
        }
    };

    useBackLayer(scanOpen, "local-scan-sheet", () => setScanOpen(false));
    useBackLayer(!!detail, "local-detail-dialog", () => setDetail(null));

    /* 匹配歌词与封面 */
    const [matchOpen, setMatchOpen] = useState(false);
    const [matchSources, setMatchSources] = useState<SerializedPlugin[]>([]);
    const [matchSourceHash, setMatchSourceHash] = useState("");
    const [matchLyric, setMatchLyric] = useState(true);
    const [matchCover, setMatchCover] = useState(true);
    const [skipMatched, setSkipMatched] = useState(true);

    const openMatchSheet = async () => {
        if (platform === "web") {
            showToast("匹配歌词与封面请在手机 App 中使用", 3200);
            return;
        }
        if (isMatchRunning()) {
            showToast("已有匹配任务在进行中");
            return;
        }
        if (!records.length) {
            showToast("本地音乐列表是空的，先扫描一下吧");
            return;
        }
        const plugins = await getSortedSearchablePlugins();
        if (!plugins.length) {
            showToast("没有可用的音源插件，请先在侧边栏的插件页安装");
            return;
        }
        setMatchSources(plugins);
        setMatchSourceHash(plugins[0].hash);
        setMatchOpen(true);
    };

    const pickMatchSource = () => {
        openSingleSelect({
            title: "匹配音源",
            subtitle: "按该音源搜索候选，再逐首匹配歌词与封面",
            options: matchSources.map((p) => ({ value: p.hash, label: p.name })),
            value: matchSourceHash,
            onSelect: setMatchSourceHash,
        });
    };

    const startMatch = () => {
        if (!matchLyric && !matchCover) {
            showToast("请至少选择匹配歌词或封面");
            return;
        }
        void startLocalMatch(records, {
            pluginHash: matchSourceHash,
            matchLyric,
            matchCover,
            skipMatched,
        }).catch((e: any) => showToast(e?.message ?? String(e), 3600));
        setMatchOpen(false);
    };

    useBackLayer(matchOpen, "local-match-sheet", () => setMatchOpen(false));

    return (
        <div className="page" style={{ padding: 0 }}>
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">本地音乐</span>
                <div className="sub-header-actions">
                    <button
                        className="icon-btn"
                        onClick={() => (search.open ? search.close() : search.setOpen(true))}
                        title="搜索本地音乐"
                    >
                        <IconSearch size={20} />
                    </button>
                    <button className="icon-btn" onClick={openMoreMenu} title="更多操作">
                        <IconMore size={20} />
                    </button>
                </div>
            </div>

            {/* 局部搜索栏 */}
            {search.open && <ListSearchBar search={search} placeholder="搜索本地音乐" />}

            {/* 匹配进度条：独立组件，进度 / 当前曲目每首歌都变时不带动整页重渲染 */}
            <LocalMatchBar />

            {musicList.length ? (
                <>
                    <PlayAllBar
                        count={viewList.length}
                        onPlayAll={playAll}
                        selectMode={selectMode}
                        selectedCount={selected.length}
                        onEnterSelect={enterSelect}
                        onExitSelect={exitSelect}
                        onSelectAll={() => setPicked([...viewList])}
                        onDeselectAll={() => setPicked([])}
                    />
                    <MusicList
                        musicList={viewList}
                        listId="localMusic"
                        showIndex
                        selectMode={selectMode}
                        selectedKeys={selectedKeys}
                        onToggleSelect={toggleSelect}
                        onRemoveItem={(item) => confirmRemove([item])}
                        removeActionLabel="删除本地音乐"
                        hideDownload
                        extraActions={(item) => [
                            {
                                label: "查看详情",
                                onClick: () => setDetail(recordById.get(`${item.id}`) ?? null),
                            },
                        ]}
                    />
                    {selectMode && (
                        <SelectActionsBar
                            count={selected.length}
                            onCollect={() => {
                                if (selected.length) {
                                    openAddToSheet(selected);
                                }
                            }}
                            onLike={() => {
                                if (!selected.length) {
                                    return;
                                }
                                const { added, skipped } = addMusicToSheetMany(
                                    LIKES_SHEET_ID,
                                    selected,
                                );
                                showToast(
                                    added
                                        ? `已喜欢 ${added} 首${skipped ? `，${skipped} 首已在喜欢列表` : ""}`
                                        : "所选歌曲都已在喜欢列表",
                                    2800,
                                );
                            }}
                            onDelete={() => {
                                if (selected.length) {
                                    confirmRemove(selected);
                                }
                            }}
                        />
                    )}
                </>
            ) : (
                <div className="empty-tip">
                    还没有本地音乐
                    <br />
                    点右上角的更多菜单，扫描设备里的音乐
                </div>
            )}

            {/* 扫描面板 */}
            {scanOpen && (
                <div className="sheet-mask" onClick={() => setScanOpen(false)}>
                    <div className="action-sheet lm-scan-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="action-sheet-song">
                            <div className="action-sheet-song-title">扫描本地音乐</div>
                            <div className="action-sheet-song-artist">
                                {dirsDefault ? "当前扫描默认目录" : "已自定义扫描目录"}
                            </div>
                        </div>
                        <div className="lm-dir-list">
                            {dirs.map((dir) => (
                                <div key={dir.path} className="lm-dir-row">
                                    <span className="lm-dir-icon">
                                        <IconFolderMusic size={16} />
                                    </span>
                                    <div className="lm-dir-info">
                                        <div className="lm-dir-label">{scanDirLabel(dir)}</div>
                                        <div className="lm-dir-path">{dir.path}</div>
                                    </div>
                                    {platform === "android" && (
                                        <button
                                            className="icon-btn lm-dir-remove"
                                            onClick={() => removeDir(dir.path)}
                                            title="移除该目录"
                                        >
                                            <IconClose size={15} />
                                        </button>
                                    )}
                                </div>
                            ))}
                            {!dirs.length && (
                                <div className="lm-dir-empty">还没有扫描目录，添加一个吧</div>
                            )}
                        </div>
                        {platform === "android" && (
                            <div className="lm-dir-ops">
                                <button className="lm-add-dir" onClick={addDir}>
                                    <IconFolderPlus size={17} />
                                    添加扫描目录
                                </button>
                                {!dirsDefault && (
                                    <button className="lm-reset-dirs" onClick={resetDirs}>
                                        恢复默认
                                    </button>
                                )}
                            </div>
                        )}
                        <div
                            className="lm-skip-row"
                            onClick={() => {
                                const next = !skipShort;
                                setSkipShort(next);
                                setSkipShortEnabled(next);
                            }}
                        >
                            <div className="lm-skip-info">
                                <div className="lm-skip-label">
                                    跳过 {SHORT_AUDIO_SECONDS} 秒以内的音频
                                </div>
                                <div className="lm-skip-desc">短提示音、铃声等通常不是正式曲目</div>
                            </div>
                            <span className={`plugin-switch ${skipShort ? "on" : ""}`} />
                        </div>
                        <button className="lm-scan-btn" disabled={scanning} onClick={startScan}>
                            {scanning ? "扫描中…" : "开始扫描"}
                        </button>
                        <button className="action-sheet-item cancel" onClick={() => setScanOpen(false)}>
                            取消
                        </button>
                    </div>
                </div>
            )}

            {/* 匹配歌词与封面面板 */}
            {matchOpen && (
                <div className="sheet-mask" onClick={() => setMatchOpen(false)}>
                    <div className="action-sheet lm-scan-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="action-sheet-song">
                            <div className="action-sheet-song-title">匹配歌词与封面</div>
                            <div className="action-sheet-song-artist">
                                用音源搜索候选，按标题 / 歌手 / 时长自动匹配
                            </div>
                        </div>
                        <div className="lm-match-source" onClick={pickMatchSource}>
                            <span className="lm-dir-icon">
                                <IconMusic size={16} />
                            </span>
                            <div className="lm-dir-info">
                                <div className="lm-dir-label">匹配音源</div>
                                <div className="lm-dir-path">
                                    {matchSources.find((p) => p.hash === matchSourceHash)?.name ??
                                        "默认音源"}
                                </div>
                            </div>
                            <span className="lm-dir-remove">
                                <IconChevronRight size={15} />
                            </span>
                        </div>
                        {(
                            [
                                ["matchLyric", matchLyric, setMatchLyric, "匹配歌词", "匹配到带时间轴的 LRC，播放页滚动展示"],
                                ["matchCover", matchCover, setMatchCover, "匹配封面", "下载专辑封面，替换列表与播放页展示"],
                                ["skipMatched", skipMatched, setSkipMatched, "跳过已匹配的歌曲", "已有歌词或封面的歌曲不再重复处理"],
                            ] as const
                        ).map(([key, value, setter, label, desc]) => (
                            <div
                                key={key}
                                className="lm-skip-row"
                                onClick={() => setter(!value)}
                            >
                                <div className="lm-skip-info">
                                    <div className="lm-skip-label">{label}</div>
                                    <div className="lm-skip-desc">{desc}</div>
                                </div>
                                <span className={`plugin-switch ${value ? "on" : ""}`} />
                            </div>
                        ))}
                        <button className="lm-scan-btn" onClick={startMatch}>
                            开始匹配（共 {records.length} 首）
                        </button>
                        <button className="action-sheet-item cancel" onClick={() => setMatchOpen(false)}>
                            取消
                        </button>
                    </div>
                </div>
            )}

            {/* 详情弹窗（音乐信息 + 文件信息） */}
            {detail && (
                <div className="dialog-mask center" onClick={() => setDetail(null)}>
                    <div className="prompt-dialog lm-detail" onClick={(e) => e.stopPropagation()}>
                        <div className="lm-detail-head">
                            <Cover
                                src={
                                    (detail.matchedArtwork || detail.artwork)
                                        ? localFileUrl(detail.matchedArtwork || detail.artwork!)
                                        : ""
                                }
                                size={52}
                                radius={8}
                            />
                            <div className="lm-detail-head-info">
                                <div className="lm-detail-title">{detail.title}</div>
                                <div className="lm-detail-sub">{detail.artist}</div>
                            </div>
                        </div>
                        <div className="lm-detail-section">
                            <div className="lm-detail-section-title">音乐信息</div>
                            <div className="lm-detail-row">
                                <span>标题</span>
                                <b>{detail.title}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>歌手</span>
                                <b>{detail.artist}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>专辑</span>
                                <b>{detail.album || "—"}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>时长</span>
                                <b>
                                    {detail.duration > 0 ? formatSeconds(detail.duration) : "未知"}
                                </b>
                            </div>
                            <div className="lm-detail-row">
                                <span>歌词</span>
                                <b>{detail.lyricPath ? "已匹配" : "未匹配"}</b>
                            </div>
                            {detail.matchedSource && (
                                <div className="lm-detail-row">
                                    <span>匹配音源</span>
                                    <b>
                                        {detail.matchedSource}
                                        {detail.matchedAt
                                            ? ` · ${formatDateTime(detail.matchedAt)}`
                                            : ""}
                                    </b>
                                </div>
                            )}
                        </div>
                        <div className="lm-detail-section">
                            <div className="lm-detail-section-title">文件信息</div>
                            <div className="lm-detail-row">
                                <span>文件名</span>
                                <b>{baseName(detail.localPath)}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>格式</span>
                                <b>{detail.format ? detail.format.toUpperCase() : "—"}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>大小</span>
                                <b>{formatFileSize(detail.size)}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>码率</span>
                                <b>{detail.bitrate ? `${detail.bitrate} kbps` : "—"}</b>
                            </div>
                            <div className="lm-detail-row">
                                <span>采样率</span>
                                <b>
                                    {detail.sampleRate
                                        ? `${(detail.sampleRate / 1000).toFixed(1)} kHz`
                                        : "—"}
                                </b>
                            </div>
                            <div className="lm-detail-row">
                                <span>修改时间</span>
                                <b>{formatDateTime(detail.mtime)}</b>
                            </div>
                            <div className="lm-detail-row lm-detail-path">
                                <span>路径</span>
                                <b>{detail.localPath}</b>
                            </div>
                        </div>
                        <div className="prompt-actions">
                            <button className="prompt-btn primary" onClick={() => setDetail(null)}>
                                关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
