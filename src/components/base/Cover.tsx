import { useState } from "react";

/** 媒体封面：加载失败时显示占位音符；children 作为角标等浮层渲染 */
export default function Cover({
    src,
    size,
    className = "",
    radius,
    fallbackSize,
    children,
}: {
    src?: string;
    size?: number | string;
    className?: string;
    radius?: number | string;
    fallbackSize?: number;
    children?: React.ReactNode;
}) {
    const [failed, setFailed] = useState(false);
    const showFallback = !src || failed;
    return (
        <div
            className={`cover ${showFallback ? "cover-fallback" : ""} ${className}`}
            style={{
                width: size,
                height: size,
                borderRadius: radius,
            }}
        >
            {!showFallback ? (
                <img
                    src={src}
                    loading="lazy"
                    onError={() => setFailed(true)}
                    alt=""
                    draggable={false}
                />
            ) : (
                <svg
                    width={fallbackSize ?? 24}
                    height={fallbackSize ?? 24}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                >
                    <circle cx="7" cy="18" r="3" />
                    <circle cx="17" cy="16" r="3" />
                    <path d="M10 18V7l10-2v11" />
                </svg>
            )}
            {children}
        </div>
    );
}
