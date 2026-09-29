/**
 * 播放历史：localStorage 持久化（结构与桌面端 store.json 的 `musicHistory` 一致，
 * 条目为 IMusicItem & {playAt}，上限 300，最大内联封面同样剥离）。
 */

export interface HistoryItem extends IMusic.IMusicItem {
    playAt: number;
}

const MAX_HISTORY_ARTWORK = 64 * 1024;
const STORAGE_KEY = "musicHistory";
const HISTORY_LIMIT = 300;

function slimArtwork<T extends IMusic.IMusicItem>(item: T): T {
    if (typeof item.artwork === "string" && item.artwork.length > MAX_HISTORY_ARTWORK) {
        return { ...item, artwork: "" };
    }
    return item;
}

export function setMusicHistory(musicItem: IMusic.IMusicItem) {
    try {
        const history = getMusicHistory();
        const filtered = history.filter(
            (it) => !(it.id === musicItem.id && it.platform === musicItem.platform),
        );
        filtered.unshift({ ...slimArtwork(musicItem), playAt: Date.now() });
        const cleaned = filtered.slice(0, HISTORY_LIMIT).map(slimArtwork);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch {
        // ignore
    }
}

export function getMusicHistory(): HistoryItem[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function clearMusicHistory() {
    localStorage.removeItem(STORAGE_KEY);
}
