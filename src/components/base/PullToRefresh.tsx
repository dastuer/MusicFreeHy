import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Spinner from "./Spinner";
import { IconChevronDown } from "./Icons";

/**
 * 下拉刷新容器：根节点自身即滚动容器，内容整体随下拉位移。
 *  - 顶部下拉超过阈值后松手触发 onRefresh，刷新期间指示器保持展开，完成自动收起；
 *  - visible=false 时整体 display:none（配合发现页三个子页常驻缓存），
 *    隐藏期间持续记录滚动位置，重新显示时恢复，避免浏览器清零 scrollTop；
 *  - 桌面浏览器里可用鼠标按住拖动模拟下拉，便于开发调试。
 */

const THRESHOLD = 52; // 触发刷新需要的下拉位移
const REFRESH_H = 52; // 刷新中指示器展开的高度
const MAX_PULL = 108; // 下拉位移上限
const DAMPING = 0.55; // 手指距离 → 位移 的衰减系数

type PtrPhase = "idle" | "pulling" | "ready" | "refreshing";

interface IPullToRefreshProps {
    onRefresh?: () => Promise<void> | void;
    /** false 时隐藏并记住滚动位置，重新显示时恢复（配合页面缓存） */
    visible?: boolean;
    className?: string;
    style?: CSSProperties;
    children: ReactNode;
}

export default function PullToRefresh({
    onRefresh,
    visible = true,
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

        // display:none 期间读取/清零 scrollTop 都不可信，只在可见时记录
        const isLaidOut = () => el.offsetParent !== null;
        const onScroll = () => {
            if (isLaidOut()) {
                savedScrollRef.current = el.scrollTop;
            }
        };
        el.addEventListener("scroll", onScroll);

        let startY = 0;
        let startX = 0;
        let pressed = false; // 按下中才可能进入下拉，防止悬停 mousemove 误触发
        let gesture = false; // 本次按下已被下拉刷新接管
        let lastTouchAt = 0; // 触摸后短暂忽略鼠标事件，避免移动端双触发
        const atTop = () => el.scrollTop <= 0;

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
            pressed = true;
            gesture = false;
            startY = e.touches[0].clientY;
            startX = e.touches[0].clientX;
        };
        const onTouchMove = (e: TouchEvent) => {
            if (!pressed) {
                return;
            }
            const t = e.touches[0];
            if (!gesture) {
                if (!shouldTakeOver(t.clientX, t.clientY)) {
                    return;
                }
                gesture = true;
            }
            e.preventDefault();
            track((t.clientY - startY) * DAMPING);
        };
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
        el.addEventListener("touchend", onGestureEnd);
        el.addEventListener("touchcancel", onGestureEnd);
        el.addEventListener("mousedown", onMouseDown);
        el.addEventListener("mousemove", onMouseMove);
        el.addEventListener("mouseup", onGestureEnd);
        el.addEventListener("mouseleave", onGestureEnd);
        return () => {
            el.removeEventListener("scroll", onScroll);
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onGestureEnd);
            el.removeEventListener("touchcancel", onGestureEnd);
            el.removeEventListener("mousedown", onMouseDown);
            el.removeEventListener("mousemove", onMouseMove);
            el.removeEventListener("mouseup", onGestureEnd);
            el.removeEventListener("mouseleave", onGestureEnd);
        };
    }, []);

    // 重新可见时恢复滚动位置（Tab 切换 / 从其他页面返回）
    useEffect(() => {
        if (visible) {
            const el = rootRef.current;
            if (el) {
                el.scrollTop = savedScrollRef.current;
            }
        }
    }, [visible]);

    return (
        <div
            ref={rootRef}
            className={`ptr${className ? ` ${className}` : ""}`}
            style={visible ? style : { ...style, display: "none" }}
        >
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
