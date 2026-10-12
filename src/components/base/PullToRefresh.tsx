import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Spinner from "./Spinner";
import { IconChevronDown } from "./Icons";

/**
 * 下拉刷新容器：根节点自身即滚动容器，内容整体随下拉位移。
 *  - 顶部下拉超过阈值后松手触发 onRefresh，刷新期间指示器保持展开，完成自动收起；
 *  - 自身不做显隐：发现页整页由外层 keepalive 负责显隐，面板常驻布局，
 *    「我的」右滑跨页时内容才能带滚动位置实时露出；
 *  - 滚动位置在 scroll 中持续记录，重新获得布局（如整页从 display:none 恢复）
 *    时经 IntersectionObserver 自动回填，避免浏览器清零 scrollTop；
 *  - 桌面浏览器里可用鼠标按住拖动模拟下拉，便于开发调试。
 */

const THRESHOLD = 52; // 触发刷新需要的下拉位移
const REFRESH_H = 52; // 刷新中指示器展开的高度
const MAX_PULL = 108; // 下拉位移上限
const DAMPING = 0.55; // 手指距离 → 位移 的衰减系数

type PtrPhase = "idle" | "pulling" | "ready" | "refreshing";

interface IPullToRefreshProps {
    onRefresh?: () => Promise<void> | void;
    className?: string;
    style?: CSSProperties;
    children: ReactNode;
}

export default function PullToRefresh({
    onRefresh,
    className,
    style,
    children,
}: IPullToRefreshProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const savedScrollRef = useRef(0);
    const phaseRef = useRef<PtrPhase>("idle");
    const [phase, setPhase] = useState<PtrPhase>("idle");
    const onRefreshRef = useRef(onRefresh);
    onRefreshRef.current = onRefresh;

    // 手势监听与滚动位置记忆（一次绑定，onRefresh 经 ref 透传避免反复重绑）
    useEffect(() => {
        const el = rootRef.current;
        const inner = innerRef.current;
        if (!el || !inner) {
            return;
        }

        // 只在真正参与布局时记录 scrollTop（display:none 期间读到的一律是 0）
        const isLaidOut = () => el.offsetParent !== null;
        const onScroll = () => {
            if (isLaidOut()) {
                savedScrollRef.current = el.scrollTop;
            }
        };
        el.addEventListener("scroll", onScroll);

        // 整页从 display:none 恢复布局时回填滚动位置（祖先 keepalive 的显隐切换）
        const io = new IntersectionObserver(() => {
            if (isLaidOut()) {
                el.scrollTop = savedScrollRef.current;
            }
        });
        io.observe(el);

        let startY = 0;
        let startX = 0;
        let pressed = false; // 按下中才可能进入下拉，防止悬停 mousemove 误触发
        let gesture = false; // 本次按下已被下拉刷新接管
        let lastTouchAt = 0; // 触摸后短暂忽略鼠标事件，避免移动端双触发
        let touchId = -1; // 手势开始时按下的触点 id；其他手指按下/抬起不参与
        const atTop = () => el.scrollTop <= 0;

        /** 从 touches 里找手势正在跟踪的那个触点（多指时取 e.touches[0] 会跳到别的手指） */
        const trackedTouch = (e: TouchEvent): Touch | null => {
            if (touchId === -1) {
                return e.touches[0] ?? null;
            }
            for (let i = 0; i < e.touches.length; i += 1) {
                if (e.touches[i].identifier === touchId) {
                    return e.touches[i];
                }
            }
            return null;
        };

        const applyPull = (dist: number) => {
            inner.style.transition = "none";
            inner.style.transform = `translateY(${dist}px)`;
            const next: PtrPhase = dist >= THRESHOLD ? "ready" : "pulling";
            if (phaseRef.current !== next) {
                phaseRef.current = next;
                setPhase(next);
            }
        };

        const collapse = (animated: boolean) => {
            inner.style.transition = animated ? "transform 0.25s ease" : "none";
            inner.style.transform = "translateY(0)";
            if (phaseRef.current !== "idle") {
                phaseRef.current = "idle";
                setPhase("idle");
            }
        };

        const runRefresh = async () => {
            phaseRef.current = "refreshing";
            setPhase("refreshing");
            inner.style.transition = "transform 0.25s ease";
            inner.style.transform = `translateY(${REFRESH_H}px)`;
            try {
                // 最少展示 450ms，避免数据太快返回时指示器一闪而过
                await Promise.all([
                    Promise.resolve(onRefreshRef.current?.()),
                    new Promise((r) => setTimeout(r, 450)),
                ]);
            } finally {
                inner.style.transition = "transform 0.3s ease";
                inner.style.transform = "translateY(0)";
                phaseRef.current = "idle";
                setPhase("idle");
                setTimeout(() => {
                    inner.style.transition = "none";
                    inner.style.transform = "";
                }, 320);
            }
        };

        // 明显的纵向下拉才接管，避免影响横向滑动与普通滚动
        const shouldTakeOver = (x: number, y: number) => {
            if (phaseRef.current === "refreshing" || !atTop()) {
                return false;
            }
            const dy = y - startY;
            return dy > 6 && dy > Math.abs(x - startX);
        };
        const track = (dist: number) => {
            applyPull(Math.max(0, Math.min(MAX_PULL, dist)));
        };

        const onTouchStart = (e: TouchEvent) => {
            lastTouchAt = Date.now();
            // 下拉进行中另一根手指按下：不重置手势现场，继续跟原手指
            if (gesture) {
                return;
            }
            pressed = true;
            const t = e.touches[0];
            touchId = t ? t.identifier : -1;
            startY = t ? t.clientY : 0;
            startX = t ? t.clientX : 0;
        };
        const onTouchMove = (e: TouchEvent) => {
            if (!pressed) {
                return;
            }
            const t = trackedTouch(e);
            if (!t) {
                return;
            }
            if (!gesture) {
                if (!shouldTakeOver(t.clientX, t.clientY)) {
                    return;
                }
                gesture = true;
            }
            e.preventDefault();
            track((t.clientY - startY) * DAMPING);
        };
        /** 松手收尾：下拉到位触发刷新，否则回弹 */
        const onGestureEnd = () => {
            pressed = false;
            if (!gesture) {
                return;
            }
            gesture = false;
            if (phaseRef.current === "ready") {
                runRefresh();
            } else {
                collapse(true);
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            // 跟踪的触点还在屏上（另一根手指先抬了）：手势继续
            if (trackedTouch(e)) {
                return;
            }
            touchId = -1;
            onGestureEnd();
        };

        const onTouchCancel = (e: TouchEvent) => {
            if (trackedTouch(e)) {
                return;
            }
            touchId = -1;
            onGestureEnd();
        };

        const onMouseDown = (e: MouseEvent) => {
            if (Date.now() - lastTouchAt < 700) {
                return;
            }
            pressed = true;
            gesture = false;
            startY = e.clientY;
            startX = e.clientX;
        };
        const onMouseMove = (e: MouseEvent) => {
            if (!pressed || Date.now() - lastTouchAt < 700) {
                return;
            }
            if (!gesture) {
                if (!shouldTakeOver(e.clientX, e.clientY)) {
                    return;
                }
                gesture = true;
            }
            e.preventDefault();
            track((e.clientY - startY) * DAMPING);
        };

        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd);
        el.addEventListener("touchcancel", onTouchCancel);
        el.addEventListener("mousedown", onMouseDown);
        el.addEventListener("mousemove", onMouseMove);
        el.addEventListener("mouseup", onGestureEnd);
        el.addEventListener("mouseleave", onGestureEnd);
        return () => {
            el.removeEventListener("scroll", onScroll);
            io.disconnect();
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchCancel);
            el.removeEventListener("mousedown", onMouseDown);
            el.removeEventListener("mousemove", onMouseMove);
            el.removeEventListener("mouseup", onGestureEnd);
            el.removeEventListener("mouseleave", onGestureEnd);
        };
    }, []);

    return (
        <div ref={rootRef} className={`ptr${className ? ` ${className}` : ""}`} style={style}>
            <div ref={innerRef} className="ptr-inner">
                <div className="ptr-indicator">
                    {phase === "refreshing" ? (
                        <>
                            <Spinner size={15} />
                            <span>刷新中…</span>
                        </>
                    ) : (
                        <>
                            <span className={`ptr-arrow ${phase === "ready" ? "flip" : ""}`}>
                                <IconChevronDown size={14} strokeWidth={2.2} />
                            </span>
                            <span>{phase === "ready" ? "释放刷新" : "下拉刷新"}</span>
                        </>
                    )}
                </div>
                {children}
            </div>
        </div>
    );
}
