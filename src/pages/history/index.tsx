import { useAtomValue } from "jotai";
import { goBack } from "@/core/router";
import {
    getMusicHistory,
    clearMusicHistory,
    musicHistoryVersionAtom,
    type HistoryItem,
} from "@/core/musicHistory";
import { showToast } from "@/core/uiAtoms";
import MusicList from "@/components/base/MusicList";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useListSearch } from "@/hooks/useListSearch";
import { IconBack, IconSearch, IconTrash } from "@/components/base/Icons";

/** 播放历史页 */
export default function HistoryPage() {
    /* 订阅历史版本号：清空、后台续播追加记录、以及在播放页给当前曲匹配到封面
       （本页可能就在浮层后面）都会让它变化，重渲染时下面的 getMusicHistory()
       自然读到最新条目。列表 id 保持常量，避免每次刷新把渲染窗口缩回顶部。 */
    useAtomValue(musicHistoryVersionAtom);
    const history: HistoryItem[] = getMusicHistory();
    const musicList = history.map(({ playAt, ...item }: any) => item);

    const search = useListSearch(musicList);
    const viewList = search.active ? search.filtered : musicList;

    return (
        <div className="page" style={{ padding: 0 }}>
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">播放历史</span>
                <div className="sub-header-actions">
                    <button
                        className="icon-btn"
                        onClick={() => (search.open ? search.close() : search.setOpen(true))}
                        title="搜索历史"
                    >
                        <IconSearch size={20} />
                    </button>
                    <button
                        className="icon-btn"
                        onClick={() => {
                            if (history.length) {
                                clearMusicHistory();
                                showToast("已清空播放历史");
                            }
                        }}
                    >
                        <IconTrash size={19} />
                    </button>
                </div>
            </div>
            {search.open && <ListSearchBar search={search} placeholder="搜索历史记录" />}
            {musicList.length ? (
                <MusicList musicList={viewList} listId="history" />
            ) : (
                <div className="empty-tip">还没有播放记录</div>
            )}
        </div>
    );
}
