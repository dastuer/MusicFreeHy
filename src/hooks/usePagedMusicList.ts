import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 「每页 N 条」的展示分页 ↔ 音源「第 M 页」的桥接层（与桌面端 usePagedMusicList 同语义）。
 *
 *  - 对外暴露「第几页 / 每页几条」的展示语义；内部维护已加载的全量列表 + 音源页码；
 *  - 追加时按 platform-id 去重（音源相邻页常重复返回同一首歌）；
 *  - 所有请求串行化，快速连点「下一页」不会重复请求同一个音源页；
 *  - 单次请求失败不会把列表锁死成「已到底」。
 */

export interface IPagedFetchResult<T> {
    items: T[];
    isEnd: boolean;
}

export interface IUsePagedMusicListOptions<T> {
    fetchPage: (page: number) => Promise<IPagedFetchResult<T>>;
    defaultPageSize: number;
    storageKey: string;
    resetKey: string;
    expectedTotal?: number;
    maxSourceFetchPerTurn?: number;
}

export interface IUsePagedMusicListResult<T> {
    items: T[];
    currentPage: number;
    totalPages: number;
    pageSize: number;
    pageSizeOptions: number[];
    isEnd: boolean;
    stalled: boolean;
    hasMore: boolean;
    expectedTotal?: number;
    loading: boolean;
    loadingMore: boolean;
    goToPage: (page: number) => void;
    changePageSize: (size: number) => void;
    replaceAll: (items: T[]) => void;
    reload: () => void;
}

export const PAGE_SIZE_OPTIONS = [40, 100, 200];

function musicKey(item: any) {
    return `${item?.platform ?? ""}-${item?.id ?? ""}`;
}

function readStoredPageSize(storageKey: string, fallback: number, options: number[]) {
    try {
        const n = Number(localStorage.getItem(storageKey));
        if (Number.isFinite(n) && options.includes(n)) {
            return n;
        }
    } catch {
        // ignore
    }
    return fallback;
}

export function usePagedMusicList<T extends { id?: string; platform?: string }>(
    options: IUsePagedMusicListOptions<T>,
): IUsePagedMusicListResult<T> {
    const { defaultPageSize, storageKey, resetKey, maxSourceFetchPerTurn = 10 } = options;
    const pageSizeOptions = PAGE_SIZE_OPTIONS;

    const fetchPageRef = useRef(options.fetchPage);
    fetchPageRef.current = options.fetchPage;
    const expectedTotalRef = useRef(options.expectedTotal);
    expectedTotalRef.current = options.expectedTotal;

    const [nonce, setNonce] = useState(0);
    const [items, setItems] = useState<T[]>([]);
    const [isEnd, setIsEnd] = useState(false);
    const [stalled, setStalled] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSizeState] = useState(() =>
        readStoredPageSize(storageKey, defaultPageSize, PAGE_SIZE_OPTIONS),
    );
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);

    // 串行化与去重用的 ref
    const sourcePageRef = useRef(1);
    const fetchingRef = useRef(false);
    const pendingTurnRef = useRef<number | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    /** 从第 1 页重新拉（resetKey / nonce / pageSize 变化时触发） */
    useEffect(() => {
        let cancelled = false;
        sourcePageRef.current = 1;
        setIsEnd(false);
        setStalled(false);
        setCurrentPage(1);
        setItems([]);
        setLoading(true);
        (async () => {
            try {
                let all: T[] = [];
                let end = false;
                let pages = 0;
                while (!end && pages < Math.min(maxSourceFetchPerTurn, 3)) {
                    const res = await fetchPageRef.current(sourcePageRef.current);
                    if (cancelled) {
                        return;
                    }
                    pages += 1;
                    const existing = new Set(all.map(musicKey));
                    const fresh = (res.items ?? []).filter(
                        (it: any) => !existing.has(musicKey(it)),
                    );
                    all = [...all, ...fresh];
                    end = !!res.isEnd || (res.items ?? []).length === 0;
                    if (!end) {
                        sourcePageRef.current += 1;
                    }
                    if (all.length >= pageSize) {
                        break;
                    }
                }
                if (cancelled) {
                    return;
                }
                setItems(all);
                setIsEnd(end);
                if (all.length === 0 && end) {
                    setStalled(false);
                }
            } catch (e) {
                console.warn("[pagedList] 首次加载失败", e);
                if (!cancelled) {
                    setItems([]);
                    setIsEnd(true);
                    setStalled(true);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey, nonce, pageSize]);

    /** 补数据直到凑满目标展示页 */
    const fillUntilPage = useCallback(
        async (targetPage: number) => {
            if (fetchingRef.current) {
                pendingTurnRef.current = targetPage;
                return;
            }
            fetchingRef.current = true;
            setLoadingMore(true);
            try {
                for (let turn = 0; turn < maxSourceFetchPerTurn; turn += 1) {
                    const res = await fetchPageRef.current(sourcePageRef.current);
                    if (!mountedRef.current) {
                        return;
                    }
                    sourcePageRef.current += 1;
                    let noNew = false;
                    setItems((prev) => {
                        const existing = new Set(prev.map(musicKey));
                        const fresh = (res.items ?? []).filter(
                            (it: any) => !existing.has(musicKey(it)),
                        );
                        noNew = fresh.length === 0;
                        return [...prev, ...fresh];
                    });
                    if (res.isEnd || (res.items ?? []).length === 0 || noNew) {
                        setIsEnd(!!res.isEnd);
                        setStalled(noNew && !res.isEnd);
                        break;
                    }
                    // 凑够了就停（保守估计：每条目都进一页）
                    if (
                        (turn + 1) * Math.max(1, (res.items ?? []).length) >=
                        (targetPage - 1) * pageSize
                    ) {
                        break;
                    }
                }
            } catch (e) {
                console.warn("[pagedList] 翻页失败", e);
            } finally {
                fetchingRef.current = false;
                setLoadingMore(false);
                if (mountedRef.current && pendingTurnRef.current !== null) {
                    const next = pendingTurnRef.current;
                    pendingTurnRef.current = null;
                    if (next > currentPageRef.current) {
                        fillUntilPage(next);
                    }
                }
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [pageSize],
    );

    const currentPageRef = useRef(1);
    currentPageRef.current = currentPage;

    const goToPage = useCallback(
        (page: number) => {
            const target = Math.max(1, page);
            const total = totalPageCount();
            if (total > 0) {
                setCurrentPage(Math.min(target, total));
            } else {
                setCurrentPage(target);
            }
            const needed = Math.min(target, total > 0 ? total : target) * pageSize;
            if (items.length < needed && !isEnd && !stalled) {
                fillUntilPage(target);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [items.length, isEnd, stalled, pageSize, fillUntilPage],
    );

    const totalPageCount = useCallback(() => {
        const expected = expectedTotalRef.current;
        if (Number.isFinite(expected) && (expected as number) > 0) {
            return Math.ceil((expected as number) / pageSize);
        }
        return Math.max(1, Math.ceil(items.length / pageSize) + (hasMoreRef.current ? 1 : 0));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageSize, items.length]);

    const hasMoreRef = useRef(false);
    hasMoreRef.current = !isEnd && !stalled;

    const changePageSize = useCallback((size: number) => {
        try {
            localStorage.setItem(storageKey, String(size));
        } catch {
            // ignore
        }
        setPageSizeState(size);
    }, []);

    const replaceAll = useCallback((next: T[]) => {
        setItems(next);
        setIsEnd(true);
        setStalled(false);
        setLoading(false);
        setLoadingMore(false);
    }, []);

    const reload = useCallback(() => {
        setNonce((n) => n + 1);
    }, []);

    return {
        items,
        currentPage,
        totalPages: totalPageCount(),
        pageSize,
        pageSizeOptions,
        isEnd,
        stalled,
        hasMore: !isEnd && !stalled,
        expectedTotal: options.expectedTotal,
        loading,
        loadingMore,
        goToPage,
        changePageSize,
        replaceAll,
        reload,
    };
}
