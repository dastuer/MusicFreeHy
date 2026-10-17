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

/**
 * 硬件音频直通（Audio Offload）：默认开。
 * 打开其他应用抢占 CPU 时由 DSP 解码出声、几乎不吃应用 CPU，后台更稳；
 * 个别 ROM 直通兼容性差（无声/爆音）时可关，回退普通解码。
 */
export function getAllowAudioOffload(): boolean {
    return getConfig("allowAudioOffload", true);
}

export function setAllowAudioOffload(v: boolean) {
    setConfig("allowAudioOffload", v);
}
