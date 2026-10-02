import { useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";
import { goBack } from "@/core/router";
import {
    getDownloadedMusicList,
    removeDownloadRecords,
    downloadsVersionAtom,
    downloadQueueViewAtom,
    downloadTasksAtom,
    downloadCounterAtom,
    pauseAllDownloads,
    resumeAllDownloads,
    stopAllDownloads,
    retryFailedDownloads,
    clearFailedDownloads,
} from "@/core/musicDownload";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { showToast } from "@/core/uiAtoms";
import MusicList from "@/components/base/MusicList";
import PlayAllBar from "@/components/base/PlayAllBar";
import SelectActionsBar from "@/components/base/SelectActionsBar";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useDownloadsMultiSelect } from "@/hooks/useDownloadsMultiSelect";
import { useListSearch } from "@/hooks/useListSearch";
import { IconBack, IconPause, IconPlay, IconRefresh, IconSearch, IconStop, IconTrash } from "@/components/base/Icons";

/** 统一列表的一行：taskKey 非空为下载任务行（实时进度由行内自订阅），否则为已完成记录行 */
type DownloadRow = {
    item: IMusic.IMusicItem;
    addedAt: number;
    addedSeq: number;
    taskKey?: string;
};

/** 顶部下载进度条：自行订阅任务队列（进度刷新只重渲染本组件），整体进度 + 暂停/继续 + 停止 + 失败快捷操作 */
function DownloadProgressBar() {
    const counter = useAtomValue(downloadCounterAtom);
    const tasks = useAtomValue(downloadTasksAtom);
    const active = tasks.filter((t) => t.status === "downloading" || t.status === "pending");
    const pausedCount = tasks.filter((t) => t.status === "paused").length;
    const failedCount = tasks.filter((t) => t.status === "error").length;
    const isPaused = !active.length && pausedCount > 0;

    // 整体进度：已完成任务数 + 各下载中任务百分比的合成（并发下载时多个任务同时在跑）
    const progressSum = tasks
        .filter((t) => t.status === "downloading" && t.progress >= 0)
        .reduce((sum, t) => sum + Math.max(0, t.progress), 0);
    const overall = counter.total
        ? Math.min(100, Math.round(((counter.done + progressSum / 100) / counter.total) * 100))
        : 0;

    const statusText = failedCount && !active.length && !pausedCount
        ? "下载失败"
        : isPaused
          ? "已暂停"
          : "下载中";

    return (
        <div className="dl-bar">
            {/* 第一行：状态 + 总览统计，纯文本不与按钮同排，保证完整展示不省略 */}
            <div className="dl-bar-overview">
                <span className="dl-bar-text">{statusText}</span>
                <span className="dl-bar-stat">共 {counter.total} 首</span>
                <span className="dl-bar-stat">成功 {counter.ok}</span>
                <span className={`dl-bar-stat ${counter.fail > 0 ? "bad" : ""}`}>
                    失败 {counter.fail}
                </span>
            </div>
            {/* 第二行：操作按钮独立成行，放不下时换行 */}
            <div className="dl-bar-actions">
                {active.length > 0 && (
                    <button className="dl-bar-btn" onClick={pauseAllDownloads}>
                        <IconPause size={14} />
                        暂停
                    </button>
                )}
                {isPaused && (
                    <button className="dl-bar-btn" onClick={resumeAllDownloads}>
                        <IconPlay size={14} />
                        继续
                    </button>
                )}
                {(active.length > 0 || pausedCount > 0) && (
                    <button className="dl-bar-btn" onClick={stopAllDownloads}>
                        <IconStop size={14} />
                        停止
                    </button>
                )}
                {failedCount > 0 && (
                    <>
                        <button className="dl-bar-btn" onClick={retryFailedDownloads}>
                            <IconRefresh size={14} />
                            重试失败
                        </button>
                        <button className="dl-bar-btn danger" onClick={clearFailedDownloads}>
                            <IconTrash size={14} />
                            清除失败
                        </button>
                    </>
                )}
            </div>
            <div className="dl-bar-track">
                <div className="dl-bar-fill" style={{ width: `${overall}%` }} />
            </div>
        </div>
    );
}

/** 「我的下载」页：顶部下载队列总进度条，下方为统一列表 ——
 *  下载中任务行与已完成记录行按「最新添加在最上、同批保持所选顺序」交织成一条列表，
 *  新添加的放在列表头部；并发下载从序号小的行开始，任务完成原地变为可播放记录行，
 *  任何行位置都不变。
 *  渲染分层：页面只订阅队列的结构视图（进度刷新不触发整页重渲染），
 *  任务行的实时进度由行内自订阅，进度刷新只重渲染正在下载的那几行 */
export default function DownloadsPage() {
    const downloadsVersion = useAtomValue(downloadsVersionAtom);

    // 下载记录：只在版本号变化时重新读取（避免每次渲染都解析 localStorage）
    const records = useMemo(() => getDownloadedMusicList(), [downloadsVersion]);

    // 任务队列结构视图：进度刷新返回同一引用，页面不随进度重渲染
    const queueView = useAtomValue(downloadQueueViewAtom);

    // 统一列表：任务行 + 记录行按添加时间倒序交织（同批按添加序号），
    // 记录继承任务的 addedAt / addedSeq，完成行因此原位不变；
    // 同一首正在下载时不重复显示其旧记录（由任务行代表它）
    const mergedRows = useMemo<DownloadRow[]>(() => {
        return [
            ...queueView.tasks.map((t) => ({
                item: t.item,
                addedAt: t.addedAt,
                addedSeq: t.addedSeq,
                taskKey: t.key,
            })),
            ...records
                .filter((r) =>
                    queueView.tasks.every((t) => t.key !== `${r.item.platform}-${r.item.id}`),
                )
                .map((r) => ({
                    item: r.item,
                    addedAt: r.addedAt ?? r.downloadedAt,
                    addedSeq: r.addedSeq ?? 0,
                })),
            // 最新添加在最上；同一批添加保持入队顺序
        ].sort((a, b) => b.addedAt - a.addedAt || a.addedSeq - b.addedSeq);
    }, [queueView, records]);
    const rowByKey = new Map(mergedRows.map((r) => [`${r.item.platform}-${r.item.id}`, r]));
    const mergedMusic = useMemo(() => mergedRows.map((r) => r.item), [mergedRows]);

    // 局部搜索：作用于统一列表（任务行 + 记录行）
    const search = useListSearch(mergedMusic);
    const viewRows: DownloadRow[] = search.active
        ? search.filtered.flatMap((it) => rowByKey.get(`${it.platform}-${it.id}`) ?? [])
        : mergedRows;
    const viewMusic = useMemo(() => viewRows.map((r) => r.item), [viewRows]);
    // 播放全部 / 多选只作用于已下载记录行
    const viewRecordItems = viewRows.filter((r) => !r.taskKey).map((r) => r.item);
    const recordItems = useMemo(() => records.map((r) => r.item), [records]);
    const multi = useDownloadsMultiSelect(recordItems, viewRecordItems);

    const playAll = () => {
        if (viewRecordItems.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                TrackPlayerSingleton.pickPlayAllStart(viewRecordItems),
                viewRecordItems,
                "downloads",
            );
        } else {
            showToast("下载列表是空的");
        }
    };

    /** 单曲删除（更多菜单）：稳定引用 */
    const removeOne = useCallback((item: IMusic.IMusicItem) => {
        void removeDownloadRecords([item]).then((res) => {
            showToast(res.removed ? `已删除「${item.title}」的下载记录` : "没有这首的下载记录", 2800);
        });
    }, []);

    return (
        <div className="page" style={{ padding: 0 }}>
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">我的下载</span>
                <div className="sub-header-actions">
                    <button
                        className="icon-btn"
                        onClick={() => (search.open ? search.close() : search.setOpen(true))}
                        title="搜索下载记录"
                    >
                        <IconSearch size={20} />
                    </button>
                </div>
            </div>
            {search.open && <ListSearchBar search={search} placeholder="搜索下载记录" />}

            {queueView.tasks.length > 0 && <DownloadProgressBar />}

            {records.length || queueView.tasks.length ? (
                <>
                    {records.length > 0 && (
                        <PlayAllBar
                            count={viewRecordItems.length}
                            onPlayAll={playAll}
                            selectMode={multi.selectMode}
                            selectedCount={multi.selected.length}
                            onEnterSelect={multi.enterSelect}
                            onExitSelect={multi.exitSelect}
                            onSelectAll={multi.selectAll}
                            onDeselectAll={multi.deselectAll}
                        />
                    )}
                    <MusicList
                        musicList={viewMusic}
                        listId="downloads"
                        showIndex
                        taskRowOf={(item) => {
                            const row = rowByKey.get(`${item.platform}-${item.id}`);
                            return row?.taskKey ? { taskKey: row.taskKey } : undefined;
                        }}
                        selectMode={multi.selectMode}
                        selectedKeys={multi.selectedKeys}
                        onToggleSelect={multi.toggleSelect}
                        onRemoveItem={removeOne}
                        removeActionLabel="删除下载记录"
                        hideDownload
                    />
                    {multi.selectMode && (
                        <SelectActionsBar
                            count={multi.selected.length}
                            onCollect={multi.startCollect}
                            onLike={multi.startLike}
                            onDelete={multi.startDelete}
                        />
                    )}
                </>
            ) : (
                <div className="empty-tip">
                    还没有下载的音乐
                    <br />
                    在歌曲列表或多选里点「下载」试试
                </div>
            )}
        </div>
    );
}
