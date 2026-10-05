/** 应用配置（localStorage 轻量封装），与桌面端同名同格式 */

export function getConfig(key: string, defaultValue?: any) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
        return defaultValue;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

export function setConfig(key: string, value: any) {
    localStorage.setItem(key, JSON.stringify(value));
}

/** 默认音质 */
export function getQuality(): IMusic.IQualityKey {
    return getConfig("defaultQuality", "standard");
}

export function setQuality(q: IMusic.IQualityKey) {
    setConfig("defaultQuality", q);
}

/** 允许与其他应用同时播放 */
export function getAllowCoPlay(): boolean {
    return getConfig("allowCoPlay", false);
}

export function setAllowCoPlay(v: boolean) {
    setConfig("allowCoPlay", v);
}
