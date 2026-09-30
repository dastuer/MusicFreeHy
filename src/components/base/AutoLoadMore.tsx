import { useEffect, useRef, useState } from "react";
import Spinner from "./Spinner";

/**
 * 列表底部「自动加载更多」页脚：
 *  - 快滚到底部（提前 400px）或内容不满一屏时自动触发 onLoadMore；
 *  - 加载中显示转圈效果；没有更多时显示结束提示；也支持点击手动加载；
 *  - 音源连续两页没带回新数据时暂停自动加载（防重复页死循环），点击可重试。
 */
export default function AutoLoadMore({
    onLoadMore,
    loadingMore = false,
    hasMore = true,
    itemsLength = 0,
    endText = "没有更多了",
    showEndTip = true,
}: {
    onLoadMore: () => void;
    loadingMore?: boolean;
    hasMore?: boolean;
    /** 当前列表条数，用于识别「加载完没有任何新数据」的空转 */
    itemsLength?: number;
    endText?: string;
    showEndTip?: boolean;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const onLoadMoreRef = useRef(onLoadMore);
    onLoadMoreRef.current = onLoadMore;

    const lenAtStartRef = useRef(itemsLength);
    const wasLoadingRef = useRef(false);
    const [emptyStreak, setEmptyStreak] = useState(0);

    // 空转检测：每次加载结束时和加载前比条数，没增长就计数 +1
    useEffect(() => {
        if (loadingMore && !wasLoadingRef.current) {
            lenAtStartRef.current = itemsLength;
        } else if (!loadingMore && wasLoadingRef.current) {
            setEmptyStreak(itemsLength > lenAtStartRef.current ? 0 : emptyStreak + 1);
        }
        wasLoadingRef.current = loadingMore;
    }, [loadingMore, itemsLength, emptyStreak]);

    const autoEnabled = hasMore && !loadingMore && emptyStreak < 2;

    useEffect(() => {
        if (!autoEnabled) {
            return;
        }
        const el = ref.current;
        if (!el) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    onLoadMoreRef.current();
                }
            },
            { rootMargin: "400px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [autoEnabled]);

    if (!hasMore) {
        return showEndTip ? <div className="loading-tip">{endText}</div> : null;
    }
    return (
        <div
            ref={ref}
            className="loading-tip loading-spin auto-load-more"
            onClick={() => {
                if (!loadingMore) {
                    setEmptyStreak(0);
                    onLoadMore();
                }
            }}
        >
            {loadingMore ? (
                <>
                    <Spinner size={16} />
                    加载中…
                </>
            ) : (
                "上拉加载更多"
            )}
        </div>
    );
}
