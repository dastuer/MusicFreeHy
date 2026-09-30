import { useCallback, useMemo, useState } from "react";
import { removeDownloadRecords, type IRemoveDownloadResult } from "@/core/musicDownload";
import { addMusicToSheetMany, LIKES_SHEET_ID } from "@/core/musicSheet";
import { openAddToSheet, showToast } from "@/core/uiAtoms";

/** 批量删除结果的播报文案 */
function describeRemoveResult(res: IRemoveDownloadResult): string {
    if (!res.removed) {
        return "所选歌曲没有下载记录";
    }
    const parts = [`已删除 ${res.removed} 首下载记录`];
    if (res.fileDeleted) {
        parts.push(`清理了 ${res.fileDeleted} 个音频文件`);
    }
    if (res.fileFailed) {
        parts.push(`${res.fileFailed} 个文件删除失败`);
    }
    if (res.systemLeft) {
        parts.push(`${res.systemLeft} 个文件在系统下载目录，请手动删除`);
    }
    return parts.join("，");
}

/**
 * 「我的下载」页多选逻辑：
 *  - 选中集合驱动 MusicList 勾选圈；
 *  - 收藏：批量加入歌单面板；
 *  - 喜欢：批量加入「我喜欢的音乐」；
 *  - 删除：删除下载记录 + 尽力删除音频文件（系统下载目录的文件删不掉，播报里提示）。
 */
export function useDownloadsMultiSelect(musicList: IMusic.IMusicItem[]) {
    const [selectMode, setSelectMode] = useState(false);
    const [pickedItems, setPickedItems] = useState<IMusic.IMusicItem[]>([]);

    /** 实际生效的选中：过滤掉已不在当前列表里的歌（如刚被删除） */
    const selected = useMemo(
        () =>
            pickedItems.filter((it) =>
                musicList.some((m) => m.platform === it.platform && m.id === it.id),
            ),
        [pickedItems, musicList],
    );

    const selectedKeys = useMemo(
        () => new Set(selected.map((it) => `${it.platform}-${it.id}`)),
        [selected],
    );

    const enterSelect = useCallback(() => {
        setPickedItems([]);
        setSelectMode(true);
    }, []);

    const exitSelect = useCallback(() => {
        setSelectMode(false);
        setPickedItems([]);
    }, []);

    const toggleSelect = useCallback((item: IMusic.IMusicItem) => {
        setPickedItems((prev) => {
            const idx = prev.findIndex((it) => it.platform === item.platform && it.id === item.id);
            if (idx >= 0) {
                return prev.filter((_, i) => i !== idx);
            }
            return [...prev, item];
        });
    }, []);

    const selectAll = useCallback(() => {
        setPickedItems([...musicList]);
    }, [musicList]);

    const deselectAll = useCallback(() => {
        setPickedItems([]);
    }, []);

    /** 批量收藏到歌单 */
    const startCollect = useCallback(() => {
        if (!selected.length) {
            return;
        }
        openAddToSheet(selected);
    }, [selected]);

    /** 批量加入「我喜欢的音乐」 */
    const startLike = useCallback(() => {
        if (!selected.length) {
            return;
        }
        const { added, skipped } = addMusicToSheetMany(LIKES_SHEET_ID, selected);
        showToast(
            added
                ? `已喜欢 ${added} 首${skipped ? `，${skipped} 首已在喜欢列表` : ""}`
                : "所选歌曲都已在喜欢列表",
            2800,
        );
    }, [selected]);

    /** 批量删除下载记录（+ 尽力删文件） */
    const startDelete = useCallback(() => {
        if (!selected.length) {
            return;
        }
        void removeDownloadRecords(selected).then((res) => {
            showToast(describeRemoveResult(res), 3600);
        });
        exitSelect();
    }, [selected, exitSelect]);

    return {
        selectMode,
        selected,
        selectedKeys,
        enterSelect,
        exitSelect,
        toggleSelect,
        selectAll,
        deselectAll,
        startCollect,
        startLike,
        startDelete,
    };
}
