import { useEffect, useRef } from "react";

/**
 * 「我的」页右滑切回「发现」Tab 的手势，与发现页排行榜的左滑跨页成对：
 *  - 拖动两页 1:1 跟手：「我的」整页右移，常驻缓存的发现页（.page-keepalive）
 *    从左侧临时显形滑入，全程实时露出目标页内容；
 *  - 松手按位移（超过页宽 15%）或甩动速度（≥0.3px/ms）决定：先补完两页滑入
 *    的动画再切 Tab（切换瞬间内容无缝），否则回弹并把发现页重新藏起；
 *  - 监听挂在 .page-swap（层页与缓存页的共同父级）：拖动中鼠标事件会随内容
 *    移动重新命中目标，挂在祖先级才能全程接收；
 *  - 纵向滑动交给页面自身滚动；浏览器已开始滚动（事件不可取消）时不接管。
 * touchmove 挂在捕获阶段，接管后阻断向内传播。
 */

const ACTIVATE_DX = 8; // 横向位移超过该值且大于纵向位移时接管手势
const SNAP_RATIO = 0.15; // 松手时位移超过页宽该比例即切换
const FLICK_VELOCITY = 0.3; // px/ms，向右甩动速度达到即切换
const COMMIT_MS = 160; // 松手补完动画时长
const SAMPLE_WINDOW = 120; // 松手测速的采样窗口 ms

interface ISample {
    x: number;
    t: number;
}

/**
 * @param onSwipe 达标后切换（在补完动画结束后调用）
 * @param enabled 是否启用手势；「我的」页在发现页轨道里还有一份常驻缓存的
 *   副本（跨页面板），副本传 false 避免两实例重复绑事件
 */
export function useSwipeToDiscover(onSwipe: () => void, enabled = true) {
    const areaRef = useRef<HTMLDivElement | null>(null);
    const onSwipeRef = useRef(onSwipe);
    const enabledRef = useRef(enabled);
    onSwipeRef.current = onSwipe;
    enabledRef.current = enabled;

    useEffect(() => {
        if (!enabledRef.current) {
            return;
        }
        const area = areaRef.current;
        if (!area) {
            return;
        }
        const swap = area.closest<HTMLElement>(".page-swap");
        const keep = swap?.querySelector<HTMLElement>(":scope > .page-keepalive") ?? null;
        if (!swap || !keep) {
            return;
        }
        // 手势现场数据不放 ref：本 hook 只服务这一个页面，effect 闭包内即可
        const g = {
            active: false,
            settled: true, // 本次按下已判定交给原生滚动处理
            startX: 0,
            startY: 0,
            rawDx: 0,
            paneW: 1,
            samples: [] as ISample[],
            suppressClick: false,
        };
        let mousePressed = false;
        let lastTouchAt = 0;
        let finishing = false; // 松手补完/回弹动画进行中，忽略新手势

        /** 两页按当前位移跟手；keep 为发现页缓存，从左侧一屏之外滑入 */
        const place = (dx: number) => {
            area.style.transition = "none";
            area.style.transform = `translateX(${dx}px)`;
            keep.style.transition = "none";
            keep.style.transform = `translateX(${dx - g.paneW}px)`;
        };

        const clearKeep = () => {
            // React 侧的 display 本就登记为 none，这里只清手势写上的位移
            keep.style.transition = "none";
            keep.style.transform = "";
        };

        const begin = (x: number, y: number) => {
            g.active = false;
            g.settled = false;
            g.startX = x;
            g.startY = y;
            g.rawDx = 0;
            g.paneW = area.clientWidth || 1;
            g.samples = [{ x, t: performance.now() }];
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

        /** 接管后逐帧跟手（1:1，位移夹在一屏内） */
        const applyDrag = (x: number, dx: number) => {
            g.rawDx = Math.max(0, Math.min(dx, g.paneW));
            place(g.rawDx);
            const now = performance.now();
            g.samples.push({ x, t: now });
            while (g.samples.length > 2 && now - g.samples[0].t > SAMPLE_WINDOW) {
                g.samples.shift();
            }
        };

        const activate = () => {
            g.active = true;
            // 临时显形发现页缓存（React 侧 display 登记为 none，直接清掉即可）
            keep.style.display = "";
            place(0);
        };

        /** 原地回弹：两页滑回原位后把发现页重新藏起 */
        const bounceBack = () => {
            area.style.transition = "transform 0.2s ease-out";
            keep.style.transition = "transform 0.2s ease-out";
            area.style.transform = "translateX(0)";
            keep.style.transform = `translateX(${-g.paneW}px)`;
            window.setTimeout(() => {
                keep.style.display = "none";
                clearKeep();
                area.style.transition = "none";
                area.style.transform = "";
                finishing = false;
            }, 230);
        };

        /** 松手：按位移与速度决定补完切换或回弹 */
        const settle = (byMouse: boolean) => {
            mousePressed = false;
            if (!g.active || finishing) {
                return;
            }
            g.active = false;
            // 鼠标拖动松手后吃掉随之而来的 click，避免误触歌单行；触摸端浏览器已抑制
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
            const movedRight = g.rawDx / g.paneW; // 正 = 向右拖
            finishing = true;
            if (velocity >= FLICK_VELOCITY || movedRight >= SNAP_RATIO) {
                // 补完：两页滑到交接位（我的完全移出、发现归位）后再切，内容无缝
                area.style.transition = `transform ${COMMIT_MS}ms ease-out`;
                keep.style.transition = `transform ${COMMIT_MS}ms ease-out`;
                area.style.transform = `translateX(${g.paneW}px)`;
                keep.style.transform = "translateX(0)";
                window.setTimeout(() => {
                    onSwipeRef.current(); // switchTab("discover")：缓存页转正
                    area.style.transition = "none";
                    area.style.transform = "";
                    clearKeep();
                    finishing = false;
                }, COMMIT_MS + 30);
            } else {
                bounceBack();
            }
        };

        const onTouchStart = (e: TouchEvent) => {
            lastTouchAt = Date.now();
            const t = e.touches[0];
            if (t) {
                begin(t.clientX, t.clientY);
            }
        };

        const onTouchMove = (e: TouchEvent) => {
            const t = e.touches[0];
            if (!t || g.settled || finishing) {
                return;
            }
            const dx = t.clientX - g.startX;
            const dy = t.clientY - g.startY;
            if (!g.active) {
                const dir = judge(dx, dy);
                if (dir === "") {
                    return;
                }
                if (dir === "v" || !e.cancelable) {
                    g.settled = true;
                    return;
                }
                activate();
            }
            // 接管后阻断页面纵向滚动与文字选择
            e.stopPropagation();
            e.preventDefault();
            applyDrag(t.clientX, dx);
        };

        const onTouchEnd = () => {
            settle(false);
        };

        const onTouchCancel = () => {
            // 系统打断：按未达标处理
            if (g.active) {
                g.active = false;
                bounceBack();
            }
        };

        // 桌面端鼠标拖动模拟，与发现页横滑的调试方式一致
        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 || Date.now() - lastTouchAt < 700) {
                return;
            }
            mousePressed = true;
            begin(e.clientX, e.clientY);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!mousePressed || g.settled || finishing) {
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
        swap.addEventListener("touchstart", onTouchStart, { passive: true });
        swap.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
        swap.addEventListener("touchend", onTouchEnd, capture);
        swap.addEventListener("touchcancel", onTouchCancel, capture);
        swap.addEventListener("mousedown", onMouseDown);
        swap.addEventListener("mousemove", onMouseMove, capture);
        swap.addEventListener("mouseup", onMouseEnd, capture);
        swap.addEventListener("mouseleave", onMouseEnd, capture);
        swap.addEventListener("click", onClickCapture, true);
        return () => {
            swap.removeEventListener("touchstart", onTouchStart);
            swap.removeEventListener("touchmove", onTouchMove, capture);
            swap.removeEventListener("touchend", onTouchEnd, capture);
            swap.removeEventListener("touchcancel", onTouchCancel, capture);
            swap.removeEventListener("mousedown", onMouseDown);
            swap.removeEventListener("mousemove", onMouseMove, capture);
            swap.removeEventListener("mouseup", onMouseEnd, capture);
            swap.removeEventListener("mouseleave", onMouseEnd, capture);
            swap.removeEventListener("click", onClickCapture, true);
        };
    }, []);

    return areaRef;
}
