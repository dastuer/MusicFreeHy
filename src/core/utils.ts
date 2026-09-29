/** 通用小工具 */

export function formatSeconds(position: number): string {
    if (!Number.isFinite(position) || position < 0) {
        return "0:00";
    }
    const total = Math.floor(position);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
}

/** 播放次数：1234 -> 1234, 31500 -> 3.2万, 123456789 -> 1.2亿 */
export function formatPlayCount(count?: number): string {
    if (!Number.isFinite(count as number) || (count as number) <= 0) {
        return "";
    }
    const n = count as number;
    if (n >= 100000000) {
        const v = n / 100000000;
        return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}亿`;
    }
    if (n >= 10000) {
        const v = n / 10000;
        return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}万`;
    }
    return String(n);
}

/** 用媒体项内部数据生成展示副标题（歌单卡片的作者/描述等） */
export function mediaItemKey(item?: { platform?: string; id?: string | number } | null): string {
    return `${item?.platform ?? ""}-${item?.id ?? ""}`;
}

export function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

/** CSS url() 需要引号包裹（data URL 里可能有未转义的括号等字符） */
export function cssUrl(url?: string): string | undefined {
    return url ? `url("${url}")` : undefined;
}
