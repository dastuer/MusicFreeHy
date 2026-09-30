import { useAtomValue } from "jotai";
import { goBack } from "@/core/router";
import {
    getDownloadedMusicList,
    removeDownloadRecords,
    downloadsVersionAtom,
    downloadTaskAtom,
} from "@/core/musicDownload";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { showToast } from "@/core/uiAtoms";
import MusicList, { CoverProgress } from "@/components/base/MusicList";
import Cover from "@/components/base/Cover";
import PlayAllBar from "@/components/base/PlayAllBar";
import SelectActionsBar from "@/components/base/SelectActionsBar";
import { useDownloadsMultiSelect } from "@/hooks/useDownloadsMultiSelect";
import { IconBack } from "@/components/base/Icons";

/** 「我的下载」页：下载记录管理（播放全部 / 喜欢 / 收藏 / 单曲与多选删除 / 下载中进度展示） */
export default function DownloadsPage() {
    const downloadsVersion = useAtomValue(downloadsVersionAtom);
    void downloadsVersion;
    const records = getDownloadedMusicList();
    const musicList = records.map((it) => it.item);

    // 下载中的任务：新歌（还没有记录）在列表顶部展示进度；已在列表里的歌由行内封面扇形展示
    const downloadTask = useAtomValue(downloadTaskAtom);
    const taskInRecords =
        downloadTask &&
        records.some(
            (it) =>
                it.item.platform === downloadTask.item.platform &&
                it.item.id === downloadTask.item.id,
        );

    const multi = useDownloadsMultiSelect(musicList);

    const playAll = () => {
        if (musicList.length) {
            TrackPlayerSingleton.playWithReplacePlayList(
                TrackPlayerSingleton.pickPlayAllStart(musicList),
                musicList,
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
            </div>

            {musicList.length || (downloadTask && !taskInRecords) ? (
                <>
                    {musicList.length > 0 && (
                        <PlayAllBar
                            count={musicList.length}
                            onPlayAll={playAll}
                            selectMode={multi.selectMode}
                            selectedCount={multi.selected.length}
                            onEnterSelect={multi.enterSelect}
                            onExitSelect={multi.exitSelect}
                            onSelectAll={multi.selectAll}
                            onDeselectAll={multi.deselectAll}
                        />
                    )}
                    {downloadTask && !taskInRecords && !multi.selectMode && (
                        <div className="music-row downloading-row">
                            <Cover
                                src={downloadTask.item.artwork}
                                size={44}
                                radius={6}
                                className="music-row-cover"
                            >
                                <CoverProgress progress={downloadTask.progress} />
                            </Cover>
                            <div className="music-row-info">
                                <div className="music-row-title">{downloadTask.item.title}</div>
                                <div className="music-row-sub">
                                    {downloadTask.item.artist}
                                    {downloadTask.batch
                                        ? ` · 批量下载中 ${downloadTask.batch.index}/${downloadTask.batch.total}`
                                        : " · 正在下载"}
                                </div>
                            </div>
                            <span className="music-row-duration">
                                {downloadTask.progress >= 0
                                    ? `${Math.round(downloadTask.progress)}%`
                                    : ""}
                            </span>
                        </div>
                    )}
                    <MusicList
                        musicList={musicList}
                        listId={`downloads:${downloadsVersion}`}
                        showIndex
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
