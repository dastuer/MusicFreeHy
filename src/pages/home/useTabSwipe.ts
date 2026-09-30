import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * 发现页三个子页的横滑切换 + tab 名称下红条的跟随滑动。
 *
 * 交互：
 *  - 在内容区横向拖动，轨道与红条逐帧跟手（直接写 DOM，拖动过程零 React 渲染）；
 *  - 松手按位移（超过页宽 15%）或甩动速度（≥0.3px/ms）决定翻页，否则回弹；
 *  - 点击 tab / goTab 跳转时由确认页变化的布局 effect 带补间动画滑到位；
 *  - 首尾页继续拖动有橡皮筋阻尼；切页动画半途再次拖动可无缝续接。
 *
 * 让位规则（原生滚动优先）：
 *  - 纵向滑动交给子页自身滚动与 PullToRefresh 下拉刷新；
 *  - 触点落在仍有该方向滚动余地的内部滚动区（精选歌单 .hscroll 等）时交给原生横滑；
 *  - 浏览器已开始滚动（事件不可取消）时不接管。
 * touchmove 挂在捕获阶段，接管后阻断向内传播，避免与子页下拉刷新同时生效。
 */

const ACTIVATE_DX = 8; // 横向位移超过该值且大于纵向位移时接管手势
const SNAP_RATIO = 0.15; // 松手时位移超过页宽该比例即翻页
const FLICK_VELOCITY = 0.3; // px/ms，甩动速度达到即翻页
const EDGE_RESIST = 0.35; // 首尾页拖出边界的阻尼
const SAMPLE_WINDOW = 120; // 松手测速的采样窗口 ms

interface ISample {
    x: number;
    t: number;
}

interface IUseTabSwipeOptions {
    /** 子页数量 */
    count: number;
    /** 当前确认的子页下标（由 tab 状态驱动） */
    index: number;
    /** 手势翻页时回写新的下标 */
    onIndexChange: (index: number) => void;
    /** 发现页整体可见（路由停留在发现页）时才响应手势 */
    enabled: boolean;
}

export function useTabSwipe({ count, index, onIndexChange, enabled }: IUseTabSwipeOptions) {
    const panesRef = useRef<HTMLDivElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const indicatorRef = useRef<HTMLSpanElement | null>(null);
    const tabRefs = useRef<(HTMLSpanElement | null)[]>([]);

    const indexRef = useRef(index);
    const enabledRef = useRef(enabled);
    const onIndexChangeRef = useRef(onIndexChange);
    indexRef.current = index;
    enabledRef.current = enabled;
    onIndexChangeRef.current = onIndexChange;

    // 手势现场数据全部放在 ref 里：拖动过程中零渲染
    const gestureRef = useRef({
        active: false,
        settled: true, // 本次按下已判定交给原生滚动处理
        startX: 0,
        startY: 0,
        startIndex: 0,
        paneW: 1,
        rawDx: 0,
        compensate: 0, // 切页动画半途被打断时接住当前进度，避免跳变
        samples: [] as ISample[],
        paintFrom: -1,
        suppressClick: false,
    });

    /** tab 文本中心相对 .home-tabs 的 x 坐标 */
    const tabCenter = (el: HTMLElement | null): number | null => {
        if (!el) {
            return null;
        }
        return el.offsetLeft + el.offsetWidth / 2;
    };

    /** 红条位置。fractional 为连续子页下标：拖动中在相邻 tab 间插值逐帧跟随 */
    const placeIndicator = useCallback(
        (fractional: number, animate: boolean) => {
            const dot = indicatorRef.current;
            if (!dot) {
                return;
            }
            const pos = Math.max(0, Math.min(count - 1, fractional));
            const from = Math.floor(pos);
            const to = Math.min(from + 1, count - 1);
            const a = tabCenter(tabRefs.current[from]);
            if (a === null) {
                return;
            }
            const b = tabCenter(tabRefs.current[to]) ?? a;
            dot.style.transition = animate ? "" : "none";
            dot.style.transform = `translateX(${a + (b - a) * (pos - from) - dot.offsetWidth / 2}px)`;
        },
        [count],
    );

    /** 轨道平移：以确认页为基准叠加像素位移，animate=false 时跟手 */
    const placeTrack = useCallback((px: number, animate: boolean) => {
        const track = trackRef.current;
        if (!track) {
            return;
        }
        track.style.transition = animate ? "" : "none";
        track.style.transform = `translateX(calc(${-indexRef.current * 100}% + ${px}px))`;
    }, []);

    /** tab 文字高亮：拖动跨过中点时直接切类名，松手后与状态对齐 */
    const paintTabs = useCallback((active: number) => {
        tabRefs.current.forEach((el, i) => {
            el?.classList.toggle("active", i === active);
        });
    }, []);

    // 确认页 / 可见性变化：带动画滑到位、红条与高亮同步收尾
    useLayoutEffect(() => {
        if (!enabled || gestureRef.current.active) {
            return;
        }
        placeTrack(0, true);
        placeIndicator(index, true);
        paintTabs(index);
    }, [index, enabled, placeTrack, placeIndicator, paintTabs]);

    // 视口尺寸变化后按确认页重新对位（页面隐藏期间不测，避免读到 0）
    useEffect(() => {
        const onResize = () => {
            if (enabledRef.current) {
                placeIndicator(indexRef.current, false);
            }
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [placeIndicator]);

    useEffect(() => {
        const area = panesRef.current;
        const track = trackRef.current;
        if (!area || !track) {
            return;
        }
        const g = gestureRef.current;
        const last = count - 1;
        let mousePressed = false;
        let lastTouchAt = 0;

        /** 触点是否位于该方向仍有滚动余地的内部横向滚动区（如 .hscroll） */
        const innerScrollerTakes = (target: EventTarget | null, dx: number): boolean => {
            let el = target instanceof Element ? target : null;
            while (el && el !== area) {
                const room = el.scrollWidth - el.clientWidth;
                if (room > 1) {
                    const ox = getComputedStyle(el).overflowX;
                    if (
                        (ox === "auto" || ox === "scroll") &&
                        (dx < 0 ? el.scrollLeft < room - 1 : el.scrollLeft > 1)
                    ) {
                        return true;
                    }
                }
                el = el.parentElement;
            }
            return false;
        };

        /** 轨道当前的实际像素位移（用于切页动画半途被打断时无缝续接） */
        const currentTrackTx = (): number => {
            const t = getComputedStyle(track).transform;
            if (!t || t === "none") {
                return 0;
            }
            try {
                return new DOMMatrixReadOnly(t).m41;
            } catch {
                return 0;
            }
        };

        const begin = (x: number, y: number) => {
            g.active = false;
            g.settled = false;
            g.startX = x;
            g.startY = y;
            g.startIndex = indexRef.current;
            g.paneW = area.clientWidth || 1;
            g.rawDx = 0;
            g.compensate = 0;
            g.samples = [{ x, t: performance.now() }];
            g.paintFrom = -1;
        };

        /** 方向判定："h" 横向接管 / "v" 纵向交出 / "" 待定 */
        const judge = (dx: number, dy: number): "h" | "v" | "" => {
            if (Math.abs(dy) > ACTIVATE_DX && Math.abs(dy) >= Math.abs(dx)) {
                return "v";
            }
            if (Math.abs(dx) > ACTIVATE_DX && Math.abs(dx) > Math.abs(dy)) {
                return "h";
            }
            return "";
        };

        /** 接管后逐帧跟手 */
        const applyDrag = (x: number, dx: number) => {
            g.rawDx = dx;
            const pRaw = g.startIndex - dx / g.paneW;
            const p =
                pRaw < 0
                    ? pRaw * EDGE_RESIST
                    : pRaw > last
                      ? last + (pRaw - last) * EDGE_RESIST
                      : pRaw;
            placeTrack((g.startIndex - p) * g.paneW + g.compensate, false);
            placeIndicator(p, false);
            const nearest = Math.round(Math.max(0, Math.min(last, p)));
            if (nearest !== g.paintFrom) {
                g.paintFrom = nearest;
                paintTabs(nearest);
            }
            const now = performance.now();
            g.samples.push({ x, t: now });
            while (g.samples.length > 2 && now - g.samples[0].t > SAMPLE_WINDOW) {
                g.samples.shift();
            }
        };

        const activate = () => {
            g.active = true;
            track.style.transition = "none";
            g.compensate = currentTrackTx() + g.startIndex * g.paneW;
        };

        /** 松手：按位移与速度决定翻页（状态驱动收尾）或原地回弹 */
        const settle = (byMouse: boolean) => {
            mousePressed = false;
            if (!g.active) {
                return;
            }
            g.active = false;
            // 鼠标拖动松手后吃掉随之而来的 click，避免误触卡片；触摸端浏览器已抑制
            g.suppressClick = byMouse;
            if (byMouse) {
                window.setTimeout(() => {
                    g.suppressClick = false;
                }, 350);
            }
            const samples = g.samples;
            let velocity = 0;
            if (samples.length >= 2) {
                const dt = performance.now() - samples[0].t;
                if (dt > 0) {
                    velocity = (samples[samples.length - 1].x - samples[0].x) / dt;
                }
            }
            const moved = -g.rawDx / g.paneW; // 正 = 向左拖 = 去下一页
            let target = g.startIndex;
            if (Math.abs(velocity) >= FLICK_VELOCITY) {
                target = g.startIndex + (velocity < 0 ? 1 : -1);
            } else if (Math.abs(moved) >= SNAP_RATIO) {
                target = g.startIndex + (moved > 0 ? 1 : -1);
            }
            const next = Math.max(0, Math.min(last, target));
            if (next !== g.startIndex) {
                // 轨道 / 红条 / 高亮的收尾动画由确认页变化的 layout effect 接管
                onIndexChangeRef.current(next);
            } else {
                placeTrack(0, true);
                placeIndicator(g.startIndex, true);
                paintTabs(g.startIndex);
            }
        };

        const onTouchStart = (e: TouchEvent) => {
            lastTouchAt = Date.now();
            if (!enabledRef.current) {
                return;
            }
            const t = e.touches[0];
            if (t) {
                begin(t.clientX, t.clientY);
            }
        };

        const onTouchMove = (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t || g.settled) {
                return;
            }
            const dx = t.clientX - g.startX;
            const dy = t.clientY - g.startY;
            if (!g.active) {
                const dir = judge(dx, dy);
                if (dir === "") {
                    return;
                }
                // 纵向 / 内部滚动区 / 浏览器已接管滚动：都不抢
                if (dir === "v" || innerScrollerTakes(e.target, dx) || !e.cancelable) {
                    g.settled = true;
                    return;
                }
                activate();
            }
            // 阻断下拉刷新的同源手势，并阻止拖动期间的纵向滚动与文字选择
            e.stopPropagation();
            e.preventDefault();
            applyDrag(t.clientX, dx);
        };

        const onTouchEnd = () => {
            settle(false);
        };

        const onTouchCancel = () => {
            // 系统打断：按未达标处理，原地回弹
            if (g.active) {
                g.active = false;
                placeTrack(0, true);
                placeIndicator(g.startIndex, true);
                paintTabs(g.startIndex);
            }
        };

        // 桌面端鼠标拖动模拟，与 PullToRefresh 的调试方式一致
        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 || Date.now() - lastTouchAt < 700 || !enabledRef.current) {
                return;
            }
            mousePressed = true;
            begin(e.clientX, e.clientY);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!mousePressed || g.settled) {
                return;
            }
            const dx = e.clientX - g.startX;
            const dy = e.clientY - g.startY;
            if (!g.active) {
                const dir = judge(dx, dy);
                if (dir === "") {
                    return;
                }
                if (dir === "v") {
                    g.settled = true;
                    return;
                }
                activate();
            }
            e.stopPropagation();
            e.preventDefault();
            applyDrag(e.clientX, dx);
        };

        const onMouseEnd = () => {
            settle(true);
        };

        const onClickCapture = (e: MouseEvent) => {
            if (g.suppressClick) {
                e.stopPropagation();
                e.preventDefault();
            }
        };

        const capture = { capture: true };
        area.addEventListener("touchstart", onTouchStart, { passive: true });
        area.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
        area.addEventListener("touchend", onTouchEnd, capture);
        area.addEventListener("touchcancel", onTouchCancel, capture);
        area.addEventListener("mousedown", onMouseDown);
        area.addEventListener("mousemove", onMouseMove, capture);
        area.addEventListener("mouseup", onMouseEnd, capture);
        area.addEventListener("mouseleave", onMouseEnd, capture);
        area.addEventListener("click", onClickCapture, true);
        return () => {
            area.removeEventListener("touchstart", onTouchStart);
            area.removeEventListener("touchmove", onTouchMove, capture);
            area.removeEventListener("touchend", onTouchEnd, capture);
            area.removeEventListener("touchcancel", onTouchCancel, capture);
            area.removeEventListener("mousedown", onMouseDown);
            area.removeEventListener("mousemove", onMouseMove, capture);
            area.removeEventListener("mouseup", onMouseEnd, capture);
            area.removeEventListener("mouseleave", onMouseEnd, capture);
            area.removeEventListener("click", onClickCapture, true);
        };
    }, [count, placeTrack, placeIndicator, paintTabs]);

    return { panesRef, trackRef, indicatorRef, tabRefs };
}
