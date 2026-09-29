/** 转圈 loading 指示器（圆弧缺口，随 currentColor 变色） */
export default function Spinner({
    size = 20,
    strokeWidth = 2.4,
}: {
    size?: number;
    strokeWidth?: number;
}) {
    return (
        <svg
            className="spinner"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
        >
            <circle cx="12" cy="12" r="9" opacity="0.22" />
            <path d="M21 12a9 9 0 0 0-9-9" />
        </svg>
    );
}
