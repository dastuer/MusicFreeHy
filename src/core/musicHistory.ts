/**
 * 播放历史：localStorage 持久化（结构与桌面端 store.json 的 `musicHistory` 一致，
 * 条目为 IMusicItem & {playAt}，上限 300，最大内联封面同样剥离）。
 *
 * 历史条目是「播放当时」的快照。本地音乐匹配到封面 / 歌词后必须回来刷新同曲条目
 * （patchMusicHistoryMeta），否则「最近在听」与播放历史页会一直显示匹配前的旧封面。
 */

import { atom, getDefaultStore } from "jotai";

export interface HistoryItem extends IMusic.IMusicItem {
    playAt: number;
}

const MAX_HISTORY_ARTWORK = 64 * 1024;
const STORAGE_KEY = "musicHistory";
const HISTORY_LIMIT = 300;

/** 历史版本号：写入 / 清空 / 就地刷新条目时自增，驱动页面重读（最近在听、播放历史页） */
export const musicHistoryVersionAtom = atom(0);

function bumpHistoryVersion() {
    const store = getDefaultStore();
    store.set(musicHistoryVersionAtom, store.get(musicHistoryVersionAtom) + 1);
}

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
        bumpHistoryVersion();
    } catch {
        // ignore
    }
}

/**
 * 就地刷新历史里同曲条目的展示元数据（封面 / 歌词）。
 *
 * 只改这一条的内容，不动顺序、不刷新 playAt——这首歌并没有被重新播放，
 * 「最近在听」的排序不该因为一次封面匹配而变化。曲目不在历史里时直接返回。
 */
export function patchMusicHistoryMeta(musicItem: IMusic.IMusicItem) {
    const artwork =
        typeof musicItem.artwork === "string" &&
        musicItem.artwork &&
        musicItem.artwork.length <= MAX_HISTORY_ARTWORK
            ? musicItem.artwork
            : "";
    const lyricSrc = musicItem.lyric?.lrc ?? musicItem.lyric?.rawLrc ?? "";
    try {
        const history = getMusicHistory();
        let changed = false;
        const next = history.map((it) => {
            if (it.id !== musicItem.id || it.platform !== musicItem.platform) {
                return it;
            }
            let patched = it;
            if (artwork && patched.artwork !== artwork) {
                patched = { ...patched, artwork };
                changed = true;
            }
            if (lyricSrc && (patched.lyric?.lrc ?? patched.lyric?.rawLrc ?? "") !== lyricSrc) {
                patched = { ...patched, lyric: musicItem.lyric };
                changed = true;
            }
            return patched;
        });
        if (!changed) {
            return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        bumpHistoryVersion();
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
    bumpHistoryVersion();
}
