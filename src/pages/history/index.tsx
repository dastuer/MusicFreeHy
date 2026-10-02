import { useState } from "react";
import { goBack } from "@/core/router";
import { getMusicHistory, clearMusicHistory, type HistoryItem } from "@/core/musicHistory";
import { showToast } from "@/core/uiAtoms";
import MusicList from "@/components/base/MusicList";
import ListSearchBar from "@/components/base/ListSearchBar";
import { useListSearch } from "@/hooks/useListSearch";
import { IconBack, IconSearch, IconTrash } from "@/components/base/Icons";

/** 播放历史页 */
export default function HistoryPage() {
    const [version, setVersion] = useState(0);
    void version;
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
                                setVersion((v) => v + 1);
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
                <MusicList musicList={viewList} listId={`history:${version}`} />
            ) : (
                <div className="empty-tip">还没有播放记录</div>
            )}
        </div>
    );
}
