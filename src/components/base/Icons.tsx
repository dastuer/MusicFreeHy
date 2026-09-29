/** 内联 SVG 图标（stroke 风格，随 currentColor 变色） */

interface IIconProps {
    size?: number;
    strokeWidth?: number;
}

function base(size: number) {
    return {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };
}

export const IconDiscover = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" fill="currentColor" stroke="none" />
    </svg>
);

export const IconSearch = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
    </svg>
);

export const IconMusic = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="7" cy="18" r="3" />
        <circle cx="17" cy="16" r="3" />
        <path d="M10 18V7l10-2v11" />
    </svg>
);

export const IconHistory = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
        <path d="M3 3v4h4" />
        <path d="M12 7.5V12l3 2" />
    </svg>
);

export const IconPuzzle = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M9 4h6v3.5a2.5 2.5 0 0 0 0 5V16H9v-3.5a2.5 2.5 0 0 0 0-5V4z" />
        <path d="M9 6H4v14h16V6h-5" />
    </svg>
);

export const IconSettings = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
);

export const IconPlay = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" stroke="none" />
    </svg>
);

export const IconPause = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
        <rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
);

export const IconPrev = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M18.5 5.5v13L9 12l9.5-6.5z" fill="currentColor" stroke="none" />
        <rect x="5" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
);

export const IconNext = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M5.5 5.5v13L15 12 5.5 5.5z" fill="currentColor" stroke="none" />
        <rect x="16.6" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
);

export const IconHeart = ({
    size = 22,
    strokeWidth = 1.8,
    filled = false,
}: IIconProps & { filled?: boolean }) => (
    <svg {...base(size)} strokeWidth={strokeWidth} fill={filled ? "currentColor" : "none"}>
        <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.9 6.7 4.9c2.2 0 3.9 1.3 5.3 3.2 1.4-1.9 3.1-3.2 5.3-3.2 3.3 0 5.3 3.1 4 6.4-1.8 4.6-9.3 9.2-9.3 9.2z" />
    </svg>
);

export const IconRepeatOff = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M17 3l3 3-3 3" />
        <path d="M20 6H7a4 4 0 0 0-4 4v1" />
        <path d="M7 21l-3-3 3-3" />
        <path d="M4 18h13a4 4 0 0 0 4-4v-1" />
    </svg>
);

export const IconRepeatQueue = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M17 3l3 3-3 3" />
        <path d="M20 6H7a4 4 0 0 0-4 4v1" />
        <path d="M7 21l-3-3 3-3" />
        <path d="M4 18h13a4 4 0 0 0 4-4v-1" />
        <path d="M9.5 9.5l2-1v4" strokeWidth={strokeWidth - 0.4} />
    </svg>
);

export const IconRepeatSingle = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M17 3l3 3-3 3" />
        <path d="M20 6H7a4 4 0 0 0-4 4v1" />
        <path d="M7 21l-3-3 3-3" />
        <path d="M4 18h13a4 4 0 0 0 4-4v-1" />
        <text
            x="12"
            y="14.7"
            fontSize="8"
            fill="currentColor"
            stroke="none"
            textAnchor="middle"
            fontWeight="600"
        >
            1
        </text>
    </svg>
);

export const IconQueue = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 6h16M4 12h10M4 18h10" />
        <circle cx="18.5" cy="17" r="2.2" fill="currentColor" stroke="none" />
        <path d="M20.7 17V9.5l1.8-.6" strokeWidth={strokeWidth - 0.4} />
    </svg>
);

export const IconMore = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
);

export const IconClose = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

export const IconChevronLeft = ({ size = 22, strokeWidth = 2 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
);

export const IconChevronDown = ({ size = 22, strokeWidth = 2 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M5.5 9l6.5 6.5L18.5 9" />
    </svg>
);

export const IconPlus = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);

export const IconHeadphone = ({ size = 14, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <rect x="3" y="14" width="4" height="6" rx="1.5" fill="currentColor" stroke="none" />
        <rect x="17" y="14" width="4" height="6" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
);

export const IconTrash = ({ size = 20, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" />
    </svg>
);

export const IconShuffle = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M16 4h4v4" />
        <path d="M20 4l-6.5 6.5" />
        <path d="M4 20l6-6" />
        <path d="M16 20h4v-4" />
        <path d="M13.5 13.5L20 20" />
        <path d="M4 4l3.5 3.5" />
        <path d="M10.5 10.5L4 4" opacity="0" />
    </svg>
);

export const IconMenu = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
);

export const IconChevronRight = ({ size = 22, strokeWidth = 2 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M9.5 5.5L16 12l-6.5 6.5" />
    </svg>
);

export const IconToplist = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M5 20V12" />
        <path d="M12 20V5" />
        <path d="M19 20v-5" />
        <path d="M3 20h18" />
    </svg>
);

export const IconLyric = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 5h16v11H9l-5 4V5z" />
        <path d="M8 9h8M8 12.5h5" />
    </svg>
);

export const IconSpeed = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4.5 17.5a8.5 8.5 0 1 1 15 0" />
        <path d="M12 13.5l4-4.5" />
        <circle cx="12" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
);

export const IconVolume = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z" />
        <path d="M15.5 9a4.5 4.5 0 0 1 0 6" />
        <path d="M18 6.5a8 8 0 0 1 0 11" />
    </svg>
);

export const IconLink = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
        <path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
    </svg>
);

export const IconFileCode = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M6 3h8l4 4v14H6V3z" />
        <path d="M14 3v4h4" />
        <path d="M10.5 12l-2 2.5 2 2.5M13.5 12l2 2.5-2 2.5" />
    </svg>
);

export const IconRefresh = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 3v4h-4" />
    </svg>
);

export const IconCheck = ({ size = 22, strokeWidth = 2 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4.5 12.5l5 5L19.5 7" />
    </svg>
);

export const IconCloudUp = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M7 18a4.5 4.5 0 0 1-.4-9A5.5 5.5 0 0 1 17.4 8.7 4 4 0 0 1 17 18" />
        <path d="M12 20v-8" />
        <path d="M8.5 15L12 11.5 15.5 15" />
    </svg>
);

export const IconCloudDown = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M7 18a4.5 4.5 0 0 1-.4-9A5.5 5.5 0 0 1 17.4 8.7 4 4 0 0 1 17 18" />
        <path d="M12 11.5v8" />
        <path d="M8.5 16.5L12 20l3.5-3.5" />
    </svg>
);

export const IconDisc = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="2.5" />
    </svg>
);

export const IconStar = ({
    size = 22,
    strokeWidth = 1.8,
    filled = false,
}: IIconProps & { filled?: boolean }) => (
    <svg {...base(size)} strokeWidth={strokeWidth} fill={filled ? "currentColor" : "none"}>
        <path d="M12 3.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />
    </svg>
);

export const IconMic = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="15" cy="9" r="4.5" />
        <path d="M11.8 12.2L5 19v0h3v-3h3v-3" />
    </svg>
);

export const IconListMusic = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <path d="M4 6h12M4 11h12M4 16h6" />
        <circle cx="16.5" cy="17.5" r="2.5" />
        <path d="M19 17.5V9l2 1" />
    </svg>
);

export const IconPlayCircle = ({ size = 22, strokeWidth = 1.8 }: IIconProps) => (
    <svg {...base(size)} strokeWidth={strokeWidth}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M10 8.5l6 3.5-6 3.5v-7z" fill="currentColor" stroke="none" />
    </svg>
);

export const IconBack = IconChevronLeft;

/** 播放中的声波动画小图标 */
export const IconPlaying = ({ size = 16 }: IIconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className="icon-playing">
        <rect x="1" y="6" width="2.4" height="4" rx="1">
            <animate
                attributeName="height"
                values="4;8;4;10;4"
                dur="1s"
                repeatCount="indefinite"
            />
            <animate
                attributeName="y"
                values="6;4;6;3;6"
                dur="1s"
                repeatCount="indefinite"
            />
        </rect>
        <rect x="5" y="4" width="2.4" height="8" rx="1">
            <animate
                attributeName="height"
                values="8;4;10;5;8"
                dur="0.9s"
                repeatCount="indefinite"
            />
            <animate
                attributeName="y"
                values="4;6;3;5.5;4"
                dur="0.9s"
                repeatCount="indefinite"
            />
        </rect>
        <rect x="9" y="6" width="2.4" height="4" rx="1">
            <animate
                attributeName="height"
                values="5;9;4;8;5"
                dur="1.1s"
                repeatCount="indefinite"
            />
            <animate
                attributeName="y"
                values="5.5;3.5;6;4;5.5"
                dur="1.1s"
                repeatCount="indefinite"
            />
        </rect>
        <rect x="13" y="5" width="2.4" height="6" rx="1">
            <animate
                attributeName="height"
                values="6;3;9;4;6"
                dur="1.05s"
                repeatCount="indefinite"
            />
            <animate
                attributeName="y"
                values="5;6.5;3.5;6;5"
                dur="1.05s"
                repeatCount="indefinite"
            />
        </rect>
    </svg>
);
