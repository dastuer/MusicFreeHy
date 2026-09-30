import { useCallback, useMemo, useState } from "react";
import {
    QUALITY_LABEL,
    downloadMusicBatch,
    removeDownloadRecords,
} from "@/core/musicDownload";
import { openMusicActions, openAddToSheet, openSingleSelect, showToast } from "@/core/uiAtoms";

/**
 * 列表页多选逻辑（推荐歌单 / 排行榜 / 本地歌单共用）：
 *  - 选中集合驱动 MusicList 勾选圈；
 *  - 下载：选音质档 → 批量串行下载；
 *  - 收藏：批量加入歌单面板；
 *  - 删除（仅本地歌单）：从歌单中删除 或 删除下载记录。
 */
export function useMusicMultiSelect(musicList: IMusic.IMusicItem[]) {
    const [selectMode, setSelectMode] = useState(false);
    const [pickedItems, setPickedItems] = useState<IMusic.IMusicItem[]>([]);
    const [downloading, setDownloading] = useState(false);

    /** 实际生效的选中：过滤掉已不在当前列表里的歌（如刚被移出歌单） */
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

    /** 批量下载：先选音质档 */
    const startDownload = useCallback(() => {
        if (!selected.length) {
            return;
        }
        const qualityOptions: IMusic.IQualityKey[] = ["standard", "high", "super", "low"];
        openSingleSelect({
            title: "下载音质",
            subtitle: `将下载 ${selected.length} 首歌曲`,
            options: qualityOptions.map((q) => ({ value: q, label: QUALITY_LABEL[q] })),
            onSelect: (v) => {
                setDownloading(true);
                void downloadMusicBatch(selected, v as IMusic.IQualityKey).finally(() => {
                    setDownloading(false);
                });
            },
        });
    }, [selected]);

    /** 批量收藏到歌单 */
    const startCollect = useCallback(() => {
        if (!selected.length) {
            return;
        }
        openAddToSheet(selected);
    }, [selected]);

    /**
     * 批量删除（仅本地歌单）：从歌单中删除 或 删除下载记录。
     * @param onRemoveFromSheet 执行「从歌单中删除」的回调（页面负责落盘 + 刷新自身状态）
     */
    const startDelete = useCallback(
        (onRemoveFromSheet: (items: IMusic.IMusicItem[]) => void) => {
            if (!selected.length) {
                return;
            }
            openMusicActions({
                musicItem: { id: "__batch__", platform: "__batch__" } as any,
                title: "删除歌曲",
                subtitle: `已选 ${selected.length} 首歌曲`,
                actions: [
                    {
                        label: "从歌单中删除",
                        danger: true,
                        onClick: () => {
                            onRemoveFromSheet(selected);
                            showToast(`已从歌单中删除 ${selected.length} 首歌曲`);
                            exitSelect();
                        },
                    },
                    {
                        label: "删除下载文件",
                        danger: true,
                        onClick: () => {
                            void removeDownloadRecords(selected).then((res) => {
                                if (!res.removed) {
                                    showToast("所选歌曲没有下载记录");
                                    return;
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
                                showToast(parts.join("，"), 3600);
                            });
                            exitSelect();
                        },
                    },
                ],
            });
        },
        [selected, exitSelect],
    );

    return {
        selectMode,
        selected,
        selectedKeys,
        downloading,
        enterSelect,
        exitSelect,
        toggleSelect,
        selectAll,
        deselectAll,
        startDownload,
        startCollect,
        startDelete,
    };
}
