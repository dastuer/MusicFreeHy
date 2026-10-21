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
    /* 记住的是「哪个地址失败了」，不是一个布尔：
       本地音乐匹配到封面、或重新匹配覆盖了同一路径的文件后 src 会换成新地址，
       这时必须重新尝试加载，否则这一格会永远停在占位音符上
       （播放条、最近在听、播放历史都因此看不见刚匹配好的封面）。 */
    const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
    const showFallback = !src || failedSrc === src;
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
                    onError={() => setFailedSrc(src)}
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
