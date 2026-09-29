import { useCallback, useRef, useState } from "react";

/**
 * 可拖动进度/音量条（Pointer Events，iPad 触控友好）。
 * 拖动中只更新本地视觉，松手才回调（避免播放器被高频 seek 打断）。
 */
export default function Slider({
    value,
    max,
    onCommit,
    height = 4,
    className = "",
}: {
    value: number;
    max: number;
    onCommit: (value: number) => void;
    height?: number;
    className?: string;
}) {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const [dragValue, setDragValue] = useState<number | null>(null);

    const posToValue = useCallback(
        (clientX: number) => {
            const el = trackRef.current;
            if (!el) {
                return 0;
            }
            const rect = el.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            return ratio * max;
        },
        [max],
    );

    const onPointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        setDragValue(posToValue(e.clientX));
        const onMove = (ev: PointerEvent) => {
            setDragValue(posToValue(ev.clientX));
        };
        const onUp = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            onCommit(posToValue(ev.clientX));
            setDragValue(null);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const shown = dragValue ?? value;
    const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0;

    return (
        <div
            className={`slider ${className}`}
            style={{ height: Math.max(height + 14, 22) }}
            onPointerDown={onPointerDown}
        >
            <div className="slider-track" ref={trackRef} style={{ height }}>
                <div className="slider-fill" style={{ width: `${pct}%` }} />
                <div
                    className="slider-thumb"
                    style={{ left: `${pct}%`, opacity: dragValue !== null || pct > 0 ? 1 : 0 }}
                />
            </div>
        </div>
    );
}
