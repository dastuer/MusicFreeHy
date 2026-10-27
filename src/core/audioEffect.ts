import { atom, getDefaultStore, useAtomValue } from "jotai";
import { getConfig, setConfig } from "./appConfig";
import { callNativeMethod, isNative } from "./native";
import { isNativeAudioBackend } from "./nativeAudio";
import { TrackPlayerEvents, TrackPlayerSingleton } from "./trackPlayer";

/**
 * 音效（与桌面版 audioEffect 同一套参数与预设，数据/备份互通）。
 *
 * 实现与桌面版完全不同：Android 上音频由 ExoPlayer 在**原生层**解码输出，
 * WebView 的 Web Audio 碰不到这段流，所以效果器用系统音频框架
 * （Equalizer / BassBoost / Virtualizer / EnvironmentalReverb）挂在
 * player 的 audioSessionId 上——见原生 AudioFx.java。
 *
 * JS 侧的职责：持有设置（localStorage 持久化 + jotai 响应式）、组织预设、
 * 每次变更**全量下发**给原生（幂等，原生整体应用一遍）。浏览器 dev 模式
 * 没有原生后端，全部 no-op。
 *
 * 与桌面版的两处平台差异：
 *  - 环绕：Android 的 Virtualizer 只有"加宽"没有"收窄"，所以环绕深度/强度
 *    的取值范围是 0~1（桌面版是 -1~1）；读取旧备份里的负值时按 0 处理。
 *  - 低音负值/高音：没有专属效果器，原生侧折算进均衡器的高/低频搁架。
 */

/** 十段均衡器频点（Hz），与桌面版一致 */
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** 十段频点的短标签（推子下方轴标） */
export const EQ_BAND_LABELS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

/** 增益可调范围（dB） */
export const EQ_GAIN_RANGE = { min: -12, max: 12 };

/** 低音 / 高音增强范围（dB） */
export const TONE_RANGE = { min: -12, max: 12 };

/**
 * 环绕参数范围。Android 的 Virtualizer 只支持单向加宽，
 * 这里取 0~1（桌面版是 -1~1，负值在这边按 0 处理）。
 */
export const SURROUND_RANGE = { min: 0, max: 1 };

export interface IEqPreset {
    name: string;
    /** 10 段增益（dB），与 EQ_BANDS 一一对应 */
    eqs: number[];
}

/** 均衡器预设：与桌面版同一张表（数值取自网易云客户端） */
export const EQ_PRESETS: IEqPreset[] = [
    { name: "无", eqs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: "流行", eqs: [-1.5, -1, 0, 1.79, 4, 3.79, 1.79, 0.5, -1, 1] },
    { name: "舞曲", eqs: [4, 5.8, 7, 0, 1.5, 3, 4.59, 4, 3.2, 0] },
    { name: "蓝调", eqs: [2, 6, 4.5, 0, -2.2, -1.5, 2, 2.5, 1.79, 3] },
    { name: "古典", eqs: [4.5, 4, 3, 2.29, -1, -1.2, 0, 1.79, 3, 4.5] },
    { name: "爵士", eqs: [3.2, 3, 1.5, 2.4, -1.5, -1, 0, 1.6, 2, 4.5] },
    { name: "慢歌", eqs: [2, 0, 0.6, 0, -0.8, 0, 0, 0, -1, 1] },
    { name: "电音", eqs: [5, 6.09, 5.2, 0, -1.6, 1.5, 0, 1, 4.57, 3.77] },
    { name: "摇滚", eqs: [4.5, 3.09, 3.4, 1.2, 0, -1, 0, 1.5, 2.79, 4.5] },
    { name: "乡村", eqs: [0, 2.2, 3, 0.6, 0, 2.29, 3.09, 1, -0.19, -0.3] },
    { name: "ACG", eqs: [4, 6.19, 3.5, -0.5, -0.8, 2, 5.19, 1, 1.5, 4] },
    { name: "低音", eqs: [6, 4.5, 6.2, 2.09, 0, 0, 0, 0, 0, 0] },
    { name: "超重低音", eqs: [6, 5.5, 8.3, 2.07, 0, 0, 0, 0, 0, 0] },
    { name: "低音&高音", eqs: [6, 5, 6.2, 1.5, 0, 0, 1, 3.2, 4, 0] },
    { name: "扬声器", eqs: [-6, -4, -2, 2, 3.5, 5.09, 3.4, 0, -3.08, -7.69] },
    { name: "现场", eqs: [5.59, 5, 6, 0, -1, 0, 3.09, 4.5, 6, 5] },
    { name: "中音", eqs: [-2, -3, -3.5, 0, 1.29, 4.5, 3.2, 2, -1.5, -2] },
    { name: "柔和", eqs: [0.5, 0.3, 0, 0, 0, 0, -0.5, -2.08, -2.79, 0] },
    { name: "柔和低音", eqs: [3.5, 2.2, 1, 0.6, 0, 0, 0, -2, -2.5, -2] },
    { name: "柔和高音", eqs: [-3, -1.88, 0, 0, 0, 0, -0.5, -1.28, 3.2, 2] },
    { name: "重金属", eqs: [-2.5, 5.29, 4.49, -2, -2.09, -1.6, 2.09, 3, 1.11, 4] },
    { name: "国风", eqs: [4, 2, 2, -0.5, -1, 3.5, 4.5, 1, 1, 3] },
    { name: "民谣", eqs: [0, 3, 0, -0.8, 1.5, 4.8, 5.8, 3.2, 0.5, 2] },
    { name: "说唱", eqs: [5.6, 5.09, 4, 0.5, -2, 1.2, 3.79, 0.5, 3.5, 4] },
];

/** 手工拖过推子后预设切到这个标签 */
export const CUSTOM_PRESET_NAME = "自定义";

/** 用户「保存」下来的曲线槽位名 */
export const USER_PRESET_NAME = "我的音效";

export interface IUserPreset {
    eqs: number[];
    bass: number;
    treble: number;
    surroundDepth: number;
    surroundStrength: number;
}

export interface IAudioEffectSettings {
    /** 总开关 */
    enabled: boolean;
    /** 当前预设名；等于 CUSTOM_PRESET_NAME 表示手工调整过 */
    preset: string;
    /** 10 段增益（dB） */
    eqs: number[];
    bass: number;
    treble: number;
    /** 环绕深度 0~1（移动端只有加宽语义） */
    surroundDepth: number;
    /** 环绕强度 0~1 */
    surroundStrength: number;
    /** 环境音效预设名，见 REVERB_PRESETS；"无" 表示不加混响 */
    reverb: string;
    /** 用户保存的曲线；没保存过为 null */
    userPreset: IUserPreset | null;
}

const STORAGE_KEY = "audioEffect";

export const REVERB_OFF = "无";

const DEFAULT_AUDIO_EFFECT: IAudioEffectSettings = {
    enabled: false,
    preset: "无",
    eqs: new Array(EQ_BANDS.length).fill(0),
    bass: 0,
    treble: 0,
    surroundDepth: 0,
    surroundStrength: 0,
    reverb: REVERB_OFF,
    userPreset: null,
};

/**
 * 环境音效预设：名字与桌面版同表，参数在原生 AudioFx.ReverbPreset 里
 * （JS 只传名字，参数表维护在原生侧）。
 */
export const REVERB_PRESETS: { name: string }[] = [
    { name: "无" },
    { name: "浴室" },
    { name: "房间" },
    { name: "地下通道" },
    { name: "声乐板" },
    { name: "弹簧" },
    { name: "音乐厅" },
    { name: "教堂" },
    { name: "大厅" },
    { name: "演唱会" },
    { name: "夜店" },
];

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

/** 把任意来源的设置收敛成合法值（长度不对补齐、超范围夹住、负环绕归零） */
function normalizeSettings(
    raw: Partial<IAudioEffectSettings> | null | undefined,
): IAudioEffectSettings {
    if (!raw || typeof raw !== "object") {
        return { ...DEFAULT_AUDIO_EFFECT, eqs: [...DEFAULT_AUDIO_EFFECT.eqs] };
    }
    const eqs = Array.isArray(raw.eqs) ? raw.eqs : [];
    const clampSurround = (v: unknown) =>
        Number.isFinite(v) ? clamp(Number(v), SURROUND_RANGE.min, SURROUND_RANGE.max) : 0;
    const rawUser = (raw as any).userPreset;
    const userPreset: IUserPreset | null =
        rawUser && typeof rawUser === "object" && Array.isArray(rawUser.eqs)
            ? {
                  eqs: EQ_BANDS.map((_, i) =>
                      Number.isFinite(rawUser.eqs?.[i])
                          ? clamp(Number(rawUser.eqs[i]), EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max)
                          : 0,
                  ),
                  bass: clampSurround(rawUser.bass),
                  treble: clampSurround(rawUser.treble),
                  surroundDepth: clampSurround(rawUser.surroundDepth),
                  surroundStrength: clampSurround(rawUser.surroundStrength),
              }
            : null;
    return {
        enabled: !!raw.enabled,
        preset:
            typeof raw.preset === "string" && raw.preset ? raw.preset : DEFAULT_AUDIO_EFFECT.preset,
        eqs: EQ_BANDS.map((_, i) =>
            Number.isFinite(eqs[i])
                ? clamp(Number(eqs[i]), EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max)
                : 0,
        ),
        bass: Number.isFinite(raw.bass)
            ? clamp(Number(raw.bass), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        treble: Number.isFinite(raw.treble)
            ? clamp(Number(raw.treble), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        surroundDepth: clampSurround(raw.surroundDepth),
        surroundStrength: clampSurround(raw.surroundStrength),
        reverb:
            typeof raw.reverb === "string" && REVERB_PRESETS.some((p) => p.name === raw.reverb)
                ? raw.reverb
                : REVERB_OFF,
        userPreset,
    };
}

const store = getDefaultStore();
const audioEffectAtom = atom<IAudioEffectSettings>(
    normalizeSettings(getConfig(STORAGE_KEY, null)),
);

export function getAudioEffectSettings(): IAudioEffectSettings {
    return store.get(audioEffectAtom);
}

export function useAudioEffect(): IAudioEffectSettings {
    return useAtomValue(audioEffectAtom);
}

// ---------- 原生下发 ----------

/** 一次下发在途标记：短时间内多次变更合并，避免拖动时打爆桥 */
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** 设置变化推给原生（80ms 合并窗口）；非原生环境 no-op */
function pushToNative() {
    if (!isNative() || !isNativeAudioBackend()) {
        return;
    }
    if (pushTimer) {
        clearTimeout(pushTimer);
    }
    pushTimer = setTimeout(() => {
        pushTimer = null;
        const settings = getAudioEffectSettings();
        callNativeMethod("PlaybackBridge", "setAudioEffect", {
            settings: JSON.stringify(settings),
        }).catch((e) => console.warn("[audioEffect] 下发设置失败", e));
    }, 80);
}

/**
 * 服务就绪后的首次同步：原生侧进程回收重建后效果器要按最新参数恢复，
 * 这里在播放后端探测完成时调一次（nativeAudio.setup 之后）。
 */
export function syncAudioEffectToNative() {
    pushToNative();
}

// ---------- 写入口（与桌面版同名同语义） ----------

function commitSettings(next: IAudioEffectSettings) {
    const normalized = normalizeSettings(next);
    store.set(audioEffectAtom, normalized);
    setConfig(STORAGE_KEY, normalized);
    pushToNative();
}

/** 总开关 */
export function setEffectEnabled(enabled: boolean) {
    const current = getAudioEffectSettings();
    if (current.enabled === enabled) {
        return;
    }
    commitSettings({ ...current, enabled });
}

/** 套用预设（「我的音效」优先于内置表） */
export function applyPreset(name: string) {
    const current = getAudioEffectSettings();
    if (name === USER_PRESET_NAME) {
        if (!current.userPreset) {
            return;
        }
        commitSettings({
            ...current,
            preset: USER_PRESET_NAME,
            eqs: [...current.userPreset.eqs],
            bass: current.userPreset.bass,
            treble: current.userPreset.treble,
            surroundDepth: current.userPreset.surroundDepth,
            surroundStrength: current.userPreset.surroundStrength,
        });
        return;
    }
    const preset = EQ_PRESETS.find((item) => item.name === name);
    if (!preset) {
        return;
    }
    commitSettings({ ...current, preset: preset.name, eqs: [...preset.eqs] });
}

/** 拖某一根推子：预设自动切成「自定义」 */
export function setBandGain(index: number, gain: number) {
    if (index < 0 || index >= EQ_BANDS.length) {
        return;
    }
    const current = getAudioEffectSettings();
    const eqs = [...current.eqs];
    eqs[index] = clamp(gain, EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max);
    commitSettings({ ...current, preset: CUSTOM_PRESET_NAME, eqs });
}

/**
 * 拖动中的即时预览：只刷 atom（音频在原生侧，预览也直接下发给原生——
 * 原生 apply 是幂等全量替换，代价很低），不写 localStorage。
 */
export function previewBand(index: number, gain: number) {
    if (index < 0 || index >= EQ_BANDS.length) {
        return;
    }
    const current = getAudioEffectSettings();
    const eqs = [...current.eqs];
    eqs[index] = clamp(gain, EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max);
    const next: IAudioEffectSettings = { ...current, preset: CUSTOM_PRESET_NAME, eqs };
    store.set(audioEffectAtom, next);
    pushToNative();
}

/** 低音 / 高音预览（拖动中，不落盘） */
export function previewTone(kind: "bass" | "treble", gain: number) {
    const current = getAudioEffectSettings();
    const next: IAudioEffectSettings = {
        ...current,
        [kind]: clamp(gain, TONE_RANGE.min, TONE_RANGE.max),
    };
    store.set(audioEffectAtom, next);
    pushToNative();
}

/** 环绕参数预览（拖动中，不落盘） */
export function previewSurround(kind: "depth" | "strength", value: number) {
    const current = getAudioEffectSettings();
    const clamped = clamp(value, SURROUND_RANGE.min, SURROUND_RANGE.max);
    const next: IAudioEffectSettings = {
        ...current,
        [kind === "depth" ? "surroundDepth" : "surroundStrength"]: clamped,
    };
    store.set(audioEffectAtom, next);
    pushToNative();
}

/** 把当前这套参数存成「我的音效」 */
export function saveUserPreset() {
    const current = getAudioEffectSettings();
    commitSettings({
        ...current,
        preset: USER_PRESET_NAME,
        userPreset: {
            eqs: [...current.eqs],
            bass: current.bass,
            treble: current.treble,
            surroundDepth: current.surroundDepth,
            surroundStrength: current.surroundStrength,
        },
    });
}

export function setBassGain(gain: number) {
    const current = getAudioEffectSettings();
    commitSettings({ ...current, bass: clamp(gain, TONE_RANGE.min, TONE_RANGE.max) });
}

export function setTrebleGain(gain: number) {
    const current = getAudioEffectSettings();
    commitSettings({ ...current, treble: clamp(gain, TONE_RANGE.min, TONE_RANGE.max) });
}

export function setSurround(kind: "depth" | "strength", value: number) {
    const current = getAudioEffectSettings();
    const clamped = clamp(value, SURROUND_RANGE.min, SURROUND_RANGE.max);
    commitSettings({
        ...current,
        [kind === "depth" ? "surroundDepth" : "surroundStrength"]: clamped,
    });
}

export function setReverbPreset(name: string) {
    const current = getAudioEffectSettings();
    const preset = REVERB_PRESETS.find((item) => item.name === name);
    commitSettings({ ...current, reverb: preset ? preset.name : REVERB_OFF });
}

/** 全部归零（含低音/高音与环绕） */
export function resetEqualizer() {
    const current = getAudioEffectSettings();
    commitSettings({
        ...current,
        preset: "无",
        eqs: new Array(EQ_BANDS.length).fill(0),
        bass: 0,
        treble: 0,
        surroundDepth: 0,
        surroundStrength: 0,
    });
}

// ---------- 时机钩子 ----------

/**
 * 播放后端就绪（原生服务起来）时同步一次：冷启动、服务被系统回收后重启，
 * 原生效果器都要按最新参数恢复。
 *
 * 回前台再补一次：WebView 冻结期间原生服务可能被杀并自动重启（MediaSessionService
 * 的机制），那时效果器是全新的、没有参数；回前台对账时顺手全量重发一遍，兜住。
 * 一次桥调用开销极小（JSON 全量幂等）。
 */
export function setupAudioEffectSync() {
    TrackPlayerSingleton.on(TrackPlayerEvents.NativeBackendReady, () => {
        syncAudioEffectToNative();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && isNativeAudioBackend()) {
            syncAudioEffectToNative();
        }
    });
}
