import { nanoid } from "nanoid";
import { atom, getDefaultStore } from "jotai";

/**
 * 用户歌单（收藏/自建）：localStorage 持久化。
 * 数据结构与桌面端 store.json 的 `userSheets` 完全一致（IUserSheet{id,title,createAt,musicList}），
 * 「我喜欢的音乐」同为固定 id `my-likes` 且钉在最前——备份文件因此可以双向互通。
 */

/** 喜欢列表版本号：任何喜欢状态变化后自增，驱动列表刷新红心状态 */
export const likesVersionAtom = atom(0);
/** 歌单列表版本号：增删歌单/改名后自增，驱动「我的音乐」刷新 */
export const sheetsVersionAtom = atom(0);

function bumpLikesVersion() {
    const store = getDefaultStore();
    store.set(likesVersionAtom, store.get(likesVersionAtom) + 1);
}

function bumpSheetsVersion() {
    const store = getDefaultStore();
    store.set(sheetsVersionAtom, store.get(sheetsVersionAtom) + 1);
}

export interface IUserSheet {
    id: string;
    title: string;
    createAt: number;
    musicList: IMusic.IMusicItem[];
}

const STORAGE_KEY = "userSheets";

/** 大体积内联封面不落盘（与桌面端同规则） */
const MAX_PERSISTED_ARTWORK = 64 * 1024;

function slimItem(item: IMusic.IMusicItem): IMusic.IMusicItem {
    if (typeof item.artwork === "string" && item.artwork.length > MAX_PERSISTED_ARTWORK) {
        return { ...item, artwork: "" };
    }
    return item;
}

export function getUserSheets(): IUserSheet[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((it: any) => it && typeof it === "object" && it.id && it.title);
    } catch {
        return [];
    }
}

export function saveSheets(sheets: IUserSheet[]) {
    const slimmed = sheets.map((sheet) => ({
        ...sheet,
        musicList: (sheet.musicList ?? []).map(slimItem),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slimmed));
    bumpSheetsVersion();
}

export function createSheet(title: string): IUserSheet {
    const sheet: IUserSheet = {
        id: nanoid(8),
        title,
        createAt: Date.now(),
        musicList: [],
    };
    const sheets = getUserSheets();
    sheets.unshift(sheet);
    saveSheets(sheets);
    return sheet;
}

export function deleteSheet(id: string) {
    saveSheets(getUserSheets().filter((it) => it.id !== id));
}

export function getSheetById(id: string): IUserSheet | undefined {
    return getUserSheets().find((it) => it.id === id);
}

/** 歌单内去重用的键（与 MusicList 的 musicKey 同构） */
export function mediaKey(musicItem: IMusic.IMusicItem) {
    return `${musicItem.platform}-${musicItem.id}`;
}

/**
 * 批量添加到歌单：一次读取、一次落盘。
 * 歌曲已在歌单内（或传入数组自身有重复）时跳过，返回实际新增/跳过的条数。
 */
export function addMusicToSheetMany(
    id: string,
    musicItems: IMusic.IMusicItem[],
): { added: number; skipped: number } {
    if (!musicItems.length) {
        return { added: 0, skipped: 0 };
    }
    const sheets = getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return { added: 0, skipped: 0 };
    }
    const seen = new Set((sheet.musicList ?? []).map(mediaKey));
    const toAdd: IMusic.IMusicItem[] = [];
    for (const musicItem of musicItems) {
        const key = mediaKey(musicItem);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        toAdd.push(musicItem);
    }
    if (toAdd.length) {
        sheet.musicList = [...toAdd, ...(sheet.musicList ?? [])];
        saveSheets(sheets);
        if (id === LIKES_SHEET_ID) {
            bumpLikesVersion();
        }
    }
    return { added: toAdd.length, skipped: musicItems.length - toAdd.length };
}

export function addMusicToSheet(id: string, musicItem: IMusic.IMusicItem) {
    return addMusicToSheetMany(id, [musicItem]);
}

/** 批量从歌单移除，返回实际移除的条数 */
export function removeMusicFromSheetMany(
    id: string,
    musicItems: IMusic.IMusicItem[],
): number {
    if (!musicItems.length) {
        return 0;
    }
    const sheets = getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return 0;
    }
    const removeKeys = new Set(musicItems.map(mediaKey));
    const before = (sheet.musicList ?? []).length;
    sheet.musicList = (sheet.musicList ?? []).filter((it) => !removeKeys.has(mediaKey(it)));
    const removed = before - sheet.musicList.length;
    if (removed) {
        saveSheets(sheets);
        if (id === LIKES_SHEET_ID) {
            bumpLikesVersion();
        }
    }
    return removed;
}

export function removeMusicFromSheet(id: string, musicItem: IMusic.IMusicItem) {
    return removeMusicFromSheetMany(id, [musicItem]);
}

export function renameSheet(id: string, title: string) {
    const sheets = getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (sheet) {
        sheet.title = title;
        saveSheets(sheets);
    }
}

/** 「我喜欢的音乐」：固定 id 的特殊歌单 */
export const LIKES_SHEET_ID = "my-likes";
export const LIKES_SHEET_TITLE = "我喜欢的音乐";

export function ensureLikesSheet(): IUserSheet {
    const sheets = getUserSheets();
    let likes = sheets.find((it) => it.id === LIKES_SHEET_ID);
    if (!likes) {
        likes = {
            id: LIKES_SHEET_ID,
            title: LIKES_SHEET_TITLE,
            createAt: 0,
            musicList: [],
        };
        saveSheets([likes, ...sheets]);
        return likes;
    }
    if (likes.title !== LIKES_SHEET_TITLE) {
        likes.title = LIKES_SHEET_TITLE;
        saveSheets(sheets);
    }
    return likes;
}

function isSameMedia(a: IMusic.IMusicItem, b: IMusic.IMusicItem) {
    return a.id === b.id && a.platform === b.platform;
}

export function isLikedMusic(musicItem: IMusic.IMusicItem): boolean {
    const likes = ensureLikesSheet();
    return (likes.musicList ?? []).some((it) => isSameMedia(it, musicItem));
}

export function getLikedMusicList(): IMusic.IMusicItem[] {
    return ensureLikesSheet().musicList ?? [];
}

/** 喜欢/取消喜欢，返回操作后的状态 */
export function toggleLike(musicItem: IMusic.IMusicItem): boolean {
    ensureLikesSheet();
    const sheets = getUserSheets();
    const likes = sheets.find((it) => it.id === LIKES_SHEET_ID)!;
    const idx = (likes.musicList ?? []).findIndex((it) => isSameMedia(it, musicItem));
    let liked: boolean;
    if (idx >= 0) {
        likes.musicList.splice(idx, 1);
        liked = false;
    } else {
        likes.musicList.unshift(musicItem);
        liked = true;
    }
    saveSheets(sheets);
    bumpLikesVersion();
    return liked;
}
