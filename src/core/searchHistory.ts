/**
 * 搜索历史（localStorage 持久化）——与桌面端同一 key、同一格式。
 */

const STORAGE_KEY = "searchHistory";

export const SEARCH_HISTORY_LIMIT = 30;

export function getSearchHistory(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
        );
    } catch {
        return [];
    }
}

function writeHistory(list: string[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // localStorage 不可用时降级为「本次不记历史」
    }
}

export function addSearchHistory(keyword: string): string[] {
    const word = keyword.trim();
    if (!word) {
        return getSearchHistory();
    }
    const next = [word, ...getSearchHistory().filter((it) => it !== word)].slice(
        0,
        SEARCH_HISTORY_LIMIT,
    );
    writeHistory(next);
    return next;
}

export function removeSearchHistory(keyword: string): string[] {
    const next = getSearchHistory().filter((it) => it !== keyword);
    writeHistory(next);
    return next;
}

export function clearSearchHistory(): string[] {
    writeHistory([]);
    return [];
}
