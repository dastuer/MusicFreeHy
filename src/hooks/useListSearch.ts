import { useMemo, useState } from "react";

/**
 * 列表页局部搜索：对当前列表按 歌名 / 歌手 / 专辑 不区分大小写过滤。
 *
 * 接线方式：页面用 `viewList = search.active ? search.filtered : musicList`
 * 渲染列表与「播放全部」，原列表数据不动，关闭搜索即还原。
 * 分页加载的列表（推荐歌单 / 排行榜 / 专辑 / 歌手）搜索的是已加载部分，
 * 后续加载的页会自动进入过滤范围。
 */
export function useListSearch(musicList: IMusic.IMusicItem[]) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const keyword = query.trim().toLowerCase();

    const filtered = useMemo(() => {
        if (!keyword) {
            return musicList;
        }
        return musicList.filter((it) =>
            [it.title, it.artist, it.album].some(
                (f) => typeof f === "string" && f.toLowerCase().includes(keyword),
            ),
        );
    }, [musicList, keyword]);

    /** 过滤真正生效中（搜索栏打开且有关键词） */
    const active = open && keyword.length > 0;

    const close = () => {
        setOpen(false);
        setQuery("");
    };

    return {
        open,
        setOpen,
        query,
        setQuery,
        filtered,
        active,
        close,
        total: musicList.length,
        matchCount: filtered.length,
    };
}

export type ListSearch = ReturnType<typeof useListSearch>;
