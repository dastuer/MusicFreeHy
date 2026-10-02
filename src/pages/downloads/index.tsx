import { useAtomValue } from "jotai";
import { goBack } from "@/core/router";
import {
    getDownloadedMusicList,
    removeDownloadRecords,
    downloadsVersionAtom,
    downloadTasksAtom,
    downloadCounterAtom,
    pauseAllDownloads,
    resumeAllDownloads,
    stopAllDownloads,
    retryDownloadTask,
    retryFailedDownloads,
    clearFailedDownloads,
    type IDownloadTask,
} from "@/core/musicDownload";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { showToast } from "@/core/uiAtoms";
import MusicList from "@/components/base/MusicList";
import Cover from "@/components/base/Cover";
import PlayAllBar from "@/components/base/PlayAllBar";
import SelectActionsBar from "@/components/base/SelectActionsBar";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useDownloadsMultiSelect } from "@/hooks/useDownloadsMultiSelect";
import { useListSearch } from "@/hooks/useListSearch";
import { IconBack, IconPause, IconPlay, IconRefresh, IconSearch, IconStop, IconTrash } from "@/components/base/Icons";

/** 队列任务的副标题：状态 + 进度 */
function taskSubText(task: IDownloadTask) {
    const base = task.item.artist || "未知艺术家";
    switch (task.status) {
        case "pending":
            return `${base} · 排队等待`;
        case "downloading":
            return task.progress >= 0
                ? `${base} · 正在下载 ${Math.round(task.progress)}%`
                : `${base} · 正在下载`;
        case "paused":
            return `${base} · 已暂停`;
        case "error":
            return `${base} · 下载失败`;
    }
}

/** 单个下载任务行：与已完成记录同构（序号/封面/信息/进度），不可交互播放 */
function DownloadTaskRow({ task, index }: { task: IDownloadTask; index: number }) {
    const failed = task.status === "error";
    // 灰底条：封面等高、左缘与封面左缘对齐，宽度按下载进度从 100% 收缩到 0%
    const frac = failed
        ? 1
        : task.progress >= 0
          ? (100 - Math.min(100, Math.max(0, task.progress))) / 100
          : 1;
    return (
        <div className={`music-row dl-task-row ${failed ? "failed" : ""}`}>
            <div
                className="dl-task-mask"
                style={{ width: `calc((100% - 42px) * ${frac.toFixed(4)})` }}
            />
            <div className="music-row-index">
                <span className="row-num">{index}</span>
            </div>
            <Cover src={task.item.artwork} size={44} radius={6} className="music-row-cover">
                {failed && (
                    <button
                        className="dl-task-retry"
                        onClick={() => retryDownloadTask(task.key)}
                        title="重试下载"
                    >
                        <IconRefresh size={18} />
                    </button>
                )}
            </Cover>
            <div className="music-row-info">
                <div className="music-row-title">{task.item.title}</div>
                <div className="music-row-sub">{taskSubText(task)}</div>
            </div>
            <div className="music-row-album">{task.item.album}</div>
            <div className="music-row-actions">
                {(task.status === "downloading" || task.status === "paused") &&
                    task.progress >= 0 && (
                        <span className="dl-task-pct">{Math.round(task.progress)}%</span>
                    )}
            </div>
        </div>
    );
}

/** 顶部下载进度条：整体进度 + 暂停/继续 + 停止 + 失败快捷操作 */
function DownloadProgressBar({ tasks }: { tasks: IDownloadTask[] }) {
    const counter = useAtomValue(downloadCounterAtom);
    const active = tasks.filter((t) => t.status === "downloading" || t.status === "pending");
    const pausedCount = tasks.filter((t) => t.status === "paused").length;
    const failedCount = tasks.filter((t) => t.status === "error").length;
    const isPaused = !active.length && pausedCount > 0;

    // 整体进度：已完成任务 + 当前任务的百分比合成
    const currentProgress = active.find((t) => t.status === "downloading")?.progress ?? -1;
    const overall = counter.total
        ? Math.min(
              100,
              Math.round(
                  ((counter.done + Math.max(0, currentProgress) / 100) / counter.total) * 100,
              ),
          )
        : 0;

    const statusText = failedCount && !active.length && !pausedCount
        ? `${failedCount} 首下载失败`
        : isPaused
          ? `已暂停 · ${counter.done}/${counter.total}`
          : `下载中 ${counter.done}/${counter.total}`;

    return (
        <div className="dl-bar">
            <div className="dl-bar-info">
                <span className="dl-bar-text">{statusText}</span>
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
            </div>
            <div className="dl-bar-track">
                <div className="dl-bar-fill" style={{ width: `${overall}%` }} />
            </div>
        </div>
    );
}

/** 「我的下载」页：顶部下载队列（进度/暂停/停止/失败重试），下方为已完成下载记录管理 */
export default function DownloadsPage() {
    const downloadsVersion = useAtomValue(downloadsVersionAtom);
    void downloadsVersion;
    const records = getDownloadedMusicList();
    const musicList = records.map((it) => it.item);

    // 下载队列：所有任务（排队/下载中/暂停/失败）都提前展示在记录列表上方
    const tasks = useAtomValue(downloadTasksAtom);

    // 局部搜索：过滤仅作用于已下载记录的列表视图与播放全部
    const search = useListSearch(musicList);
    const viewList = search.active ? search.filtered : musicList;
    const multi = useDownloadsMultiSelect(musicList, viewList);

    const playAll = () => {
        if (viewList.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                TrackPlayerSingleton.pickPlayAllStart(viewList),
                viewList,
                "downloads",
            );
        } else {
            showToast("下载列表是空的");
        }
    };

    /** 单曲删除（更多菜单 / 左滑风格入口由 MusicList 提供） */
    const removeOne = (item: IMusic.IMusicItem) => {
        void removeDownloadRecords([item]).then((res) => {
            showToast(res.removed ? `已删除「${item.title}」的下载记录` : "没有这首的下载记录", 2800);
        });
    };

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

            {tasks.length > 0 && <DownloadProgressBar tasks={tasks} />}

            {musicList.length || tasks.length ? (
                <>
                    {musicList.length > 0 && (
                        <PlayAllBar
                            count={viewList.length}
                            onPlayAll={playAll}
                            selectMode={multi.selectMode}
                            selectedCount={multi.selected.length}
                            onEnterSelect={multi.enterSelect}
                            onExitSelect={multi.exitSelect}
                            onSelectAll={multi.selectAll}
                            onDeselectAll={multi.deselectAll}
                        />
                    )}
                    {tasks.length > 0 && (
                        <div className="dl-task-list">
                            {/* 按队列顺序展示：第一首在最上面、先下载先完成，完成后落入下方记录列表 */}
                            {tasks.map((t, i) => (
                                <DownloadTaskRow key={t.key} task={t} index={i + 1} />
                            ))}
                        </div>
                    )}
                    <MusicList
                        musicList={viewList}
                        listId={`downloads:${downloadsVersion}`}
                        showIndex
                        indexOffset={tasks.length}
                        selectMode={multi.selectMode}
                        selectedKeys={multi.selectedKeys}
                        onToggleSelect={multi.toggleSelect}
                        onRemoveItem={removeOne}
                        removeActionLabel="删除下载记录"
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
