import { atom, getDefaultStore, useAtomValue } from "jotai";
import EventEmitter from "eventemitter3";
import { buildPlayableMediaUrl } from "./net";
import { getPluginByMedia, getPlugins, pluginCall } from "./ipc";
import { setMusicHistory } from "./musicHistory";
import { getQuality, setQuality, getConfig, getAllowCoPlay } from "./appConfig";
import { localFileUrl } from "./native";
import { lookupCachedSrc, requestAudioCacheStore } from "./audioCache";
import {
    createAudioElement,
    destroyAudioBackend,
    NativeAudioElement,
} from "./nativeAudio";

export type MusicState = "playing" | "paused" | "stopped" | "loading";
export type MusicRepeatMode = "off" | "queue" | "single";

/**
 * 内联封面尺寸上限。超过就认为它是"整张图塞成 base64"，
 * 不该进 localStorage、也不该交给 MediaMetadata（与桌面端同规则）。
 */
const MAX_PERSISTED_ARTWORK = 64 * 1024;

export const enum TrackPlayerEvents {
    PlayEnd = "PlayEnd",
    CurrentMusicChanged = "CurrentMusicChanged",
    ProgressChanged = "ProgressChanged",
    StateChanged = "StateChanged",
    /** 音源解析 / 音频加载失败（payload 见 IPlayFailurePayload） */
    PlayFailed = "PlayFailed",
}

/** 播放失败事件的载荷 */
export interface IPlayFailurePayload {
    musicItem: IMusic.IMusicItem;
    reason: string;
    willSkip: boolean;
    downgradedTo?: IMusic.IQualityKey;
}

/** `applyQuality` 的结果：UI 按它决定提示语 */
export interface IQualitySwitchResult {
    status: "switched" | "queued" | "cancelled" | "failed";
    /** 实际生效的音质（插件没有对应档位时会是降到的那一档） */
    quality?: IMusic.IQualityKey;
    reason?: string;
}

/**
 * 单次 getMediaSource 的最长等待。
 * 换歌时旧歌已经被停掉，等待期是静音的，所以不能让一个卡死的音源拖满 pluginCall 的 30s。
 * 下限要容得下移动端的多级解析链：策略下发 + eapi + outer-url 重定向跟随
 * （VIP 歌会整包拉一次试听 mp3 再回退酷我 search/nmobi），弱网下 10s 会误杀正常解析。
 */
const MEDIA_SOURCE_TIMEOUT = 15000;

/** 连续 N 首都播不出来就停下，不再自动往后跳（否则坏音源会把整个歌单空转一圈） */
const MAX_AUTO_SKIP = 3;

/** 网络断流原地重连上限：每次成功开播后重新计数（熄屏 WiFi 休眠 / 省电限网的抖动自救） */
const MAX_STREAM_RECONNECT = 2;

/** 本曲内音质降级重试的上限 */
const MAX_QUALITY_RETRY = 3;

/** 播放历史留多少首（上一首按它回退） */
const MAX_HISTORY = 50;

/** 「记忆播放进度」的最小起播位置 / 结尾间隔（与桌面端 playProgress 同规则） */
const MIN_REMEMBER_POSITION = 5;
const END_GAP = 5;

/**
 * 队列里认一首歌用的键。与 `musicSheet` 的 `mediaKey` 同一约定。
 */
function playListKey(musicItem: IMusic.IMusicItem) {
    return `${musicItem.platform}-${musicItem.id}`;
}

/** 能进播放队列吗：得有 id（去重和增删都按它认） */
function isQueueable(musicItem?: IMusic.IMusicItem | null) {
    return !!musicItem?.id && !musicItem.localPath?.startsWith?.("tmp");
}

/** 把一份列表整理成能进播放队列的样子：没有 id 的丢掉，同一首只留第一份。 */
function toQueueableList(musicItems: IMusic.IMusicItem[]) {
    const seen = new Set<string>();
    return musicItems.filter((it) => {
        if (!isQueueable(it) || seen.has(playListKey(it))) {
            return false;
        }
        seen.add(playListKey(it));
        return true;
    });
}

/** MediaError 转成人话（见 HTMLMediaElement.error；原生后端错误同形） */
function describeMediaError(err?: Pick<MediaError, "code" | "message"> | null) {
    switch (err?.code) {
        case 1:
            return "音频加载被中断";
        case 2:
            return "音频流网络中断";
        case 3:
            return "音频解码失败";
        case 4:
            return "音源返回的音频无法播放（链接可能已失效）";
        default:
            return "音频加载失败";
    }
}

/** play() 抛出的异常转成人话 */
function describePlayError(e: any) {
    if (e?.name === "NotSupportedError") {
        return "音源返回的音频无法播放（链接可能已失效）";
    }
    if (e?.name === "NotAllowedError") {
        return "浏览器未允许自动播放";
    }
    if (e?.name === "AbortError") {
        return "播放被新的请求中断";
    }
    return e?.message ?? String(e ?? "未知原因");
}

/** 音质档位从低到高：对齐与降级都按这个顺序（下载去重 / 降档重试也按它比较） */
export const QUALITY_LADDER: IMusic.IQualityKey[] = ["low", "standard", "high", "super"];

/** ---------- 无缝切音质（后台预取 + 交接） ---------- */

/** 新音源至少要缓冲到「当前播放位置之后多少秒」才允许交接 */
const SEAMLESS_LEAD = 1.5;

/** 预取总超时：到点还没缓冲好就放弃，继续用当前音质播（不让切换把播放拖停） */
const SEAMLESS_TIMEOUT = 20000;

/** 预取状态轮询间隔 */
const SEAMLESS_POLL = 250;

/** 两次推送预取位置的最小间隔，避免播放头追着缓冲一路 seek */
const SEAMLESS_RESEEK_GAP = 1500;

/**
 * 预取迟迟没有数据时，让预取播放器以静音方式先跑起来催它取流。
 * iOS/Safari 会无视未开播元素的 preload，光等就永远缓冲不出来。
 */
const SEAMLESS_KICK_DELAY = 3000;

/** `position` 之后连续可播的缓冲末端；没落进缓冲区间返回 0 */
function bufferedEndAfter(audio: AudioBackend, position: number): number {
    const ranges = audio.buffered;
    let end = 0;
    for (let i = 0; i < ranges.length; i++) {
        // 允许 0.25s 的小空隙，避免为了尾数一直不交接
        if (ranges.start(i) <= position + 0.25 && ranges.end(i) > end) {
            end = ranges.end(i);
        }
    }
    return end;
}

/** ---------- 无缝切下一首（后台预加载 + 交接） ---------- */

/**
 * 换歌的空隙来自两段：插件解析音源（最长 15s）+ 音频加载缓冲。
 * 当前歌剩 NEXT_PRELOAD_AHEAD 秒时就把下一首的这两段提前做完，播完零间隙续上：
 *  - WebView 后端：解析出直链后另开一个 <audio> 预缓冲，ended 时直接交接（同切音质的 probe 模式）；
 *  - 原生 ExoPlayer 后端（单实例，双播放器会顶掉正在播的歌）：把下一首 append 进
 *    播放列表，ExoPlayer 自己预缓冲并在当前曲目播完时无缝自动续播，JS 只在
 *    itemtransition 事件里做换歌簿记（弹 atom / 刷媒体会话），不碰播放器。
 * 任一环节不顺利（解析失败 / 缓冲不动）就放弃预加载，ended 时走原有换歌链路兜底。
 */

/** 剩余多少秒开始预加载下一首 */
const NEXT_PRELOAD_AHEAD = 30;

/** 预加载失败后同曲多久内不重试（避免坏音源在结尾反复打插件） */
const NEXT_PRELOAD_RETRY_AFTER = 60000;

/** WebView 预缓冲元素视为就绪的最小缓冲秒数 */
const NEXT_PRELOAD_PROBE_LEAD = 3;

/** 预缓冲迟迟没有数据时静音催流的等待时间（iOS 会无视未开播元素的 preload） */
const NEXT_PRELOAD_KICK_DELAY = 3000;

/** 预缓冲就绪轮询间隔 */
const NEXT_PRELOAD_POLL = 1000;

/** 下一首的预加载记录 */
interface INextTrackPreload {
    musicItem: IMusic.IMusicItem;
    /** resolveMediaUrl 的成功结果（commit 时的音质 / 音源状态以它为准） */
    resolved: {
        src: string;
        source?: IPlugin.IMediaSourceResult;
        quality: IMusic.IQualityKey | null;
        localDownload?: true;
    } | null;
    /** 缓存判定后的最终播放地址 */
    playSrc: string | null;
    /** WebView 后端：预缓冲用的临时播放器 */
    probe: AudioBackend | null;
    /** 原生后端：是否已 append 进 ExoPlayer 播放列表 */
    appended: boolean;
}

/**
 * 条目声明了可用音质（`qualities`）时对齐请求档（与桌面端同规则）。
 */
function pickSupportedQuality(
    requested: IMusic.IQualityKey,
    qualities?: IMusic.IQuality,
): IMusic.IQualityKey | null {
    if (!qualities || typeof qualities !== "object") {
        return null;
    }
    const supported = QUALITY_LADDER.filter((q) => qualities[q]);
    if (!supported.length) {
        return null;
    }
    const reqIdx = QUALITY_LADDER.indexOf(requested);
    const atOrBelow = supported.filter((q) => QUALITY_LADDER.indexOf(q) <= reqIdx);
    return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : supported[0];
}

/** 解析音源用的音质尝试序列：从起始档逐级下降，最多 3 档 */
function resolveQualityLadder(first: IMusic.IQualityKey): IMusic.IQualityKey[] {
    const idx = QUALITY_LADDER.indexOf(first);
    const ladder = QUALITY_LADDER.slice(0, idx + 1).reverse();
    if (!ladder.includes("standard")) {
        ladder.push("standard");
    }
    return ladder.slice(0, 3);
}

/** 音质序号（低→高），未知档位按 -1；下载去重与降档重试的档位比较都走这里 */
export function qualityRank(q: IMusic.IQualityKey): number {
    return QUALITY_LADDER.indexOf(q);
}

/** 从某档起逐级往低的音质序列（下载失败降档重试用）：[first, ..., "low"] */
export function qualityLadderDown(first: IMusic.IQualityKey): IMusic.IQualityKey[] {
    const idx = Math.max(0, QUALITY_LADDER.indexOf(first));
    return QUALITY_LADDER.slice(0, idx + 1).reverse();
}

/** ---------- jotai atoms ---------- */
export const DEFAULT_VOLUME = 0.8;

function getStoredVolume(): number {
    const raw = localStorage.getItem("volume");
    if (raw === null) {
        return DEFAULT_VOLUME;
    }
    const stored = Number(raw);
    return Number.isFinite(stored) ? Math.min(Math.max(stored, 0), 1) : DEFAULT_VOLUME;
}

export const playListAtom = atom<IMusic.IMusicItem[]>([]);
export const currentMusicAtom = atom<IMusic.IMusicItem | null>(null);
export const musicStateAtom = atom<MusicState>("stopped");
export const repeatModeAtom = atom<MusicRepeatMode>("off");
export const progressAtom = atom<{ position: number; duration: number }>({
    position: 0,
    duration: 0,
});
export const rateAtom = atom<number>(1);
export const volumeAtom = atom<number>(getStoredVolume());
export const qualityAtom = atom<IMusic.IQualityKey>(getQuality());
export const playingQualityAtom = atom<IMusic.IQualityKey | null>(null);
/** 正在无缝切换到哪个音质（null = 没有切换在途） */
export const qualitySwitchingAtom = atom<IMusic.IQualityKey | null>(null);
export const playListAddedAtom = atom(0);

const store = getDefaultStore();

function setAtom<T>(atom_: any, value: T) {
    store.set(atom_, value);
}

/** ---------- 播放进度记忆 ---------- */

export interface IPlayProgressRecord {
    music: IMusic.IMusicItem;
    position: number;
    duration: number;
    updatedAt: number;
}

const PROGRESS_KEY = "playProgress";

function isRememberProgressEnabled(): boolean {
    return getConfig("rememberProgress", true) !== false;
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function slimMusic(musicItem: IMusic.IMusicItem): IMusic.IMusicItem {
    return typeof musicItem.artwork === "string" && musicItem.artwork.length > MAX_PERSISTED_ARTWORK
        ? { ...musicItem, artwork: "" }
        : musicItem;
}

function getStoredProgress(): IPlayProgressRecord | null {
    try {
        const raw = localStorage.getItem(PROGRESS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed?.music?.platform && parsed?.music?.id) {
            return parsed;
        }
    } catch {
        // ignore
    }
    return null;
}

function getStoredCurrentMusic(): IMusic.IMusicItem | null {
    try {
        const raw = localStorage.getItem("currentMusic");
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed?.platform && parsed?.id ? parsed : null;
    } catch {
        return null;
    }
}

/** ---------- 已下载歌曲的本地播放 ---------- */

/** 已下载歌曲的本地音源：src 为 WebView 可播放的本地文件地址 */
export interface IDownloadedLocalSource {
    src: string;
    /** 下载时实际落盘的音质档（null 表示拿不到） */
    quality: IMusic.IQualityKey | null;
}

/**
 * 已下载歌曲的本地音源解析器（由 musicDownload 模块注册，避免循环依赖）：
 * 播放器解析音源前先问它，本曲已有可播放的下载文件就直接播本地，
 * 不再走插件解析线上直链。返回 null 表示没有本地文件（未下载 / 已被删除）。
 */
let downloadedSourceResolver:
    | ((musicItem: IMusic.IMusicItem) => Promise<IDownloadedLocalSource | null>)
    | null = null;

export function setDownloadedSourceResolver(
    fn: (musicItem: IMusic.IMusicItem) => Promise<IDownloadedLocalSource | null>,
) {
    downloadedSourceResolver = fn;
}

/** ---------- 播放器 ---------- */

/**
 * 播放器后端：Android 上优先 ExoPlayer 代理（不参与音频焦点仲裁 + 大缓冲，
 * 共播时抖音抢焦点不影响播放），插件缺失回退 WebView <audio>。
 */
type AudioBackend = HTMLAudioElement | NativeAudioElement;

class TrackPlayer extends EventEmitter {
    private audio: AudioBackend | null = null;
    private _repeatMode: MusicRepeatMode = "off";
    private _playList: IMusic.IMusicItem[] = [];
    /** 当前队列是哪份列表装进来的（整队替换标识，重启时跟着队列一起还原） */
    private _currentListId = "";
    /** 播过的歌，按播放顺序，最后一项就是当前这首。 */
    private _history: IMusic.IMusicItem[] = [];
    /** 「下一首播放」压进来的歌，`playListKey` 按登记先后排列。只在内存里。 */
    private _pendingNext: string[] = [];
    private _currentMusic: IMusic.IMusicItem | null = null;
    private _rate = 1;
    private pendingPlayId = "";
    private isLoading = false;
    private autoSkipCount = 0;
    private autoSkipping = false;
    private playSeq = 0;
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    private stallNudges = 0;
    private reconnecting = false;
    private reconnectCount = 0;
    private pendingSeekListener: (() => void) | null = null;
    private pendingStartPosition = 0;
    private resolvedQuality: IMusic.IQualityKey | null = null;
    private resolvedSourceUrl: string | null = null;
    private qualityRetrying = false;
    private qualityRetryCount = 0;
    /** 无缝切音质时后台缓冲用的临时播放器，交接后变成主播放器 */
    private probeAudio: AudioBackend | null = null;
    /** 在途切换的序号：换歌 / 再次切换时用它作废旧预取 */
    private qualitySwitchSeq = 0;
    /** 当前播放是否来自「已下载的本地文件」：失败兜底与音质切换按 localPath 同规则处理 */
    private playedFromLocalDownload = false;
    /** 本地下载文件播放失败过的歌（本次会话内直接走线上，不再反复撞同一个坏文件） */
    private localDownloadBypass = new Set<string>();
    /** 接下来的一次 pause 事件是应用主动发起的（区别于系统抢音频焦点打断） */
    private internalPausePending = false;
    /** 用户主动暂停了（播放键 / 通知栏 / 耳机）：共播回抢据此让位，换歌/恢复播放时清零 */
    private userPaused = false;
    /** 主动暂停的序号：标记共播回抢发生过的会话序号 */
    private userPauseSeq = 0;
    /** 共播续播巡逻的定时器：后台页面定时器被强节流，靠 visibilitychange 补跑 */
    private coPlayResumeTimer: ReturnType<typeof setTimeout> | null = null;
    /** 正在执行的共播续播尝试序号：换歌 / 用户暂停时作废在途 play() */
    private coPlayResumeSeq = 0;
    /** 下一首的预加载记录（null = 没有在途预加载） */
    private nextPreload: INextTrackPreload | null = null;
    /** 预加载会话序号：换歌 / 队列变动 / 换音质时作废在途预加载 */
    private nextPreloadSeq = 0;
    /** 预加载流程启动中（resolve 是异步的，防止 timeupdate 高频重入） */
    private preloadStarting = false;
    /** 最近一次预加载失败的曲键与时间：同曲一段时间内不再撞同一个坏音源 */
    private preloadFailedKey = "";
    private preloadFailedAt = 0;

    setup() {
        if (this.audio) {
            return;
        }
        // 先造 WebView <audio> 占位（探测是异步的，别让首播等它）；
        // 原生后端可用时无缝换成 ExoPlayer 代理。
        const audio: AudioBackend = new Audio();
        audio.preload = "auto";
        audio.volume = getStoredVolume();
        this.attachAudioListeners(audio);
        this.audio = audio;
        applyCoPlaySessionType();
        void createAudioElement().then((backend) => {
            if (this.audio !== audio) {
                return; // 期间已经被换掉（理论不可能，防御）
            }
            const previous = this.audio;
            // 占位 <audio> 已在播：换后端后按原进度续播（探测通常几十毫秒内完成，
            // 冷启动抢在这个窗口开播的概率很低，但仍要兜住）
            const wasPlaying = !!previous.src && !previous.paused && !previous.error;
            const resumePosition = previous.currentTime || 0;
            const resumeSrc = previous.src;
            backend.preload = "auto";
            backend.volume = getStoredVolume();
            this.attachAudioListeners(backend);
            this.audio = backend;
            this.destroyAudioElement(previous);
            this.syncLoopFlag();
            this.applyNativeFocusMode();
            if (wasPlaying && this._currentMusic) {
                backend.src = resumeSrc;
                this.applyStartPosition(backend, resumePosition);
                backend.play().catch((e: any) => {
                    console.warn("[trackPlayer] 原生后端接管起播失败", e?.name ?? e);
                });
            }
        });

        // Pad 版：切后台 / 关页面前把「听到哪儿」写进 localStorage（桌面端是退出握手写 session.json）
        const persist = () => this.persistProgress();
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
                persist();
            }
        });
        window.addEventListener("pagehide", persist);

        this.restoreSession();
        this.syncLoopFlag();
    }

    private attachAudioListeners(audio: AudioBackend) {
        audio.addEventListener("ended", this.onEnded);
        audio.addEventListener("timeupdate", this.onProgress);
        audio.addEventListener("loadedmetadata", this.onProgress);
        audio.addEventListener("pause", this.onAudioPause);
        audio.addEventListener("play", this.onAudioPlay);
        audio.addEventListener("playing", this.onAudioPlaying);
        audio.addEventListener("error", this.onAudioError);
        audio.addEventListener("waiting", this.onAudioWaiting);
        audio.addEventListener("stalled", this.onAudioStall);
        // 仅原生后端会发：ExoPlayer 播完当前曲目自动续播预载的下一首
        audio.addEventListener("itemtransition", this.onItemTransition);
    }

    private detachAudioListeners(audio: AudioBackend) {
        audio.removeEventListener("ended", this.onEnded);
        audio.removeEventListener("timeupdate", this.onProgress);
        audio.removeEventListener("loadedmetadata", this.onProgress);
        audio.removeEventListener("pause", this.onAudioPause);
        audio.removeEventListener("play", this.onAudioPlay);
        audio.removeEventListener("playing", this.onAudioPlaying);
        audio.removeEventListener("error", this.onAudioError);
        audio.removeEventListener("waiting", this.onAudioWaiting);
        audio.removeEventListener("stalled", this.onAudioStall);
        audio.removeEventListener("itemtransition", this.onItemTransition);
    }

    /** 彻底弃用一个播放器实例：摘掉监听，免得它的 pause/error 事件回头改状态 */
    private destroyAudioElement(audio: AudioBackend) {
        this.detachAudioListeners(audio);
        destroyAudioBackend(audio);
    }

    /**
     * 还原「上次播放会话」：队列 + 当前歌 + 进度，全部来自 localStorage。
     * 只改状态与 atom，不自动出声（要不要接着听由用户按播放决定）。
     */
    private restoreSession() {
        try {
            let playList: IMusic.IMusicItem[] | null = null;
            try {
                const raw = localStorage.getItem("playList");
                const parsed = raw ? JSON.parse(raw) : null;
                if (Array.isArray(parsed) && parsed.length) {
                    playList = parsed;
                }
            } catch {
                // ignore
            }
            if (playList?.length) {
                this._playList = toQueueableList(playList);
                this._currentListId = localStorage.getItem("currentListId") ?? "";
                setAtom(playListAtom, this._playList);
                if (this._playList.length !== playList.length) {
                    localStorage.setItem("playList", JSON.stringify(this._playList));
                }
            }

            const progress = getStoredProgress();
            const music =
                progress?.music && progress.music.platform
                    ? progress.music
                    : getStoredCurrentMusic();
            if (music?.platform && music?.id) {
                let position = 0;
                if (
                    isRememberProgressEnabled() &&
                    progress &&
                    playListKey(progress.music) === playListKey(music)
                ) {
                    const raw = Number(progress.position);
                    const duration = Number(progress.duration) || 0;
                    if (
                        Number.isFinite(raw) &&
                        raw >= MIN_REMEMBER_POSITION &&
                        !(duration > 0 && raw > duration - END_GAP)
                    ) {
                        position = raw;
                    }
                }
                this._currentMusic = music;
                setAtom(currentMusicAtom, music);
                if (position > 0) {
                    setAtom(progressAtom, {
                        position,
                        duration: progress?.duration || music.duration || 0,
                    });
                    this.pendingStartPosition = position;
                }
            }

            const savedRepeat = localStorage.getItem("repeatMode");
            if (savedRepeat) {
                this._repeatMode = savedRepeat as MusicRepeatMode;
                setAtom(repeatModeAtom, this._repeatMode);
            }
        } catch (e) {
            console.warn("[trackPlayer] 恢复上次播放失败", e);
        }
    }

    /** 当前歌曲 + 听到哪儿（切后台 / 关页面前落盘用） */
    private collectProgress(): IPlayProgressRecord | null {
        const music = this._currentMusic;
        if (!music?.platform || !music?.id) {
            return null;
        }
        const audio = this.audio;
        const hasSource = !!audio?.src;
        const progress = store.get(progressAtom);
        const audioDuration =
            hasSource && Number.isFinite(audio?.duration ?? NaN)
                ? (audio!.duration as number)
                : 0;
        return {
            music: slimMusic(music),
            position: round1(hasSource ? audio!.currentTime || 0 : progress.position || 0),
            duration: round1(audioDuration || progress.duration || music.duration || 0),
            updatedAt: Date.now(),
        };
    }

    private persistProgress() {
        try {
            if (!isRememberProgressEnabled()) {
                return;
            }
            const record = this.collectProgress();
            if (record) {
                localStorage.setItem(PROGRESS_KEY, JSON.stringify(record));
            }
        } catch {
            // ignore
        }
    }

    /** ---------- 内部事件 ---------- */
    private onProgress = () => {
        if (!this.audio) {
            return;
        }
        this.clearStallWatch();
        const progress = {
            position: this.audio.currentTime || 0,
            duration: this.audio.duration || 0,
        };
        setAtom(progressAtom, progress);
        this.emit(TrackPlayerEvents.ProgressChanged, progress);
        const remaining =
            Number.isFinite(progress.duration) && progress.duration > 0
                ? progress.duration - progress.position
                : Infinity;
        this.maybeStartNextTrackPreload(remaining);
        // seek 回中段后剩余时间又变多了：停掉被静音催播的预缓冲元素，别让它白跑
        const probe = this.nextPreload?.probe;
        if (probe && !probe.paused && remaining > NEXT_PRELOAD_AHEAD) {
            probe.pause();
        }
    };

    private clearStallWatch = () => {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
    };

    /** 播放停滞自救：12 秒还没恢复就微调进度，强制浏览器重新取流 */
    private onAudioStall = () => {
        this.beginStallWatch();
    };

    /** 缓冲断流（waiting）：界面切成「加载中」转圈，恢复出声时 playing 事件再切回来 */
    private onAudioWaiting = () => {
        const audio = this.audio;
        if (
            audio &&
            !audio.paused &&
            this._currentMusic &&
            store.get(musicStateAtom) === "playing"
        ) {
            setAtom(musicStateAtom, "loading");
        }
        this.beginStallWatch();
    };

    private beginStallWatch() {
        if (this.stallTimer) {
            return;
        }
        this.stallTimer = setTimeout(() => {
            this.stallTimer = null;
            const audio = this.audio;
            if (!audio || audio.paused || audio.ended) {
                return;
            }
            if (this.stallNudges >= 3) {
                // 微调救不回来（多半是流已经死了）：原地重连重新取流，别一直哑着
                this.tryReconnectStream();
                return;
            }
            this.stallNudges += 1;
            try {
                audio.currentTime = (audio.currentTime || 0) + 0.05;
            } catch {
                // ignore
            }
        }, 12000);
    }

    private onAudioPause = () => {
        // 先消费「主动暂停」标记：没标记的 pause 事件就是系统抢音频焦点导致的
        const internal = this.internalPausePending;
        this.internalPausePending = false;
        this.clearStallWatch();
        if (this.isLoading) {
            return;
        }
        if (internal) {
            this.userPaused = true;
        }
        if (this._currentMusic) {
            setAtom(musicStateAtom, "paused");
        }
        this.syncMediaSessionState();
        if (!internal) {
            this.handleFocusLossSilently();
        }
    };

    /**
     * 共播模式下被抢了音频焦点（其他应用开播把 WebView 的播放暂停了）：
     * 先同步回抢一次，抢不回来就进「续播巡逻」——短暂停表后按指数退避重试，
     * 直到续播成功 / 用户暂停 / 换歌 / 巡逻时间耗尽。
     *
     * 为什么单次回抢不够（刷抖音卡顿暂停的实测根因）：抖音这种「声明 TRANSIENT
     * 焦点再立即放弃」的高频抢焦点应用，会在 pause 事件同帧再次抢走焦点，此时
     * 同步 play() 常抛 AbortError；而页面在后台时定时器被内核强节流，旧实现
     * 又没有重试，让位一次就永久停了（已暂停的页面没有任何事件能再触发续播）。
     * 音频焦点只是建议性的，系统本来就允许两个流混音：巡逻期每次 play() 成功后
     * 音频与对方同时出声（参考网易云的做法：抢不过就等它松手再续，而不是让位）。
     *
     * 原生后端（ExoPlayer）下这个方法不会被触发：共播开时根本不参与焦点仲裁，
     * 没有任何外部应用能让我们暂停 —— 这正是把播放搬出 WebView 的意义。
     *
     * 全程静默：不翻 UI 播放态、不刷媒体通知，避免焦点拉锯时界面抖动。
     * 用户主动暂停（暂停键/通知栏/换歌）走 internalPausePending，不进这里。
     */
    private handleFocusLossSilently() {
        const audio = this.audio;
        if (
            !getAllowCoPlay()
            || this.userPaused
            || !audio
            || !this._currentMusic
            || !audio.src
            || audio.ended
            || audio.error
            || this.reconnecting
            || this.qualityRetrying
        ) {
            return;
        }
        const seq = ++this.coPlayResumeSeq;
        audio.play().catch((e) => {
            if (seq !== this.coPlayResumeSeq || audio !== this.audio || this.userPaused) {
                return;
            }
            console.warn("[trackPlayer] 共播回抢被拦截，转入续播巡逻", e?.name ?? e);
            this.startCoPlayResumeWatch(seq);
        });
    }

    /**
     * 把共播开关同步给原生后端的焦点策略：
     * 共播开 → ExoPlayer 不参与音频焦点仲裁（抖音随便抢，我们不动）；
     * 共播关 → 正常仲裁（别人开播我们让位暂停）。
     * WebView 回退路径没有这个能力，靠上面的巡逻兜底。
     */
    applyNativeFocusMode() {
        const audio = this.audio;
        if (audio instanceof NativeAudioElement) {
            audio.setAudioFocusMode(!getAllowCoPlay());
        }
    }

    /**
     * 续播巡逻：play() 被拒后按 300ms→600ms→…（上限 2s）退避重试，总巡逻 45s。
     * 后台页面 setInterval 可能被节流到 1 次/分钟，所以另挂 visibilitychange
     * 兜底：抖音退后台 / 用户切回来时立刻补一次，不让「页面不可见」拖死巡逻。
     */
    private startCoPlayResumeWatch(seq: number) {
        this.stopCoPlayResumeWatch();
        let delay = 300;
        const startedAt = Date.now();
        const attempt = () => {
            this.coPlayResumeTimer = null;
            const audio = this.audio;
            if (
                seq !== this.coPlayResumeSeq
                || !audio
                || !audio.src
                || this.userPaused
                || !getAllowCoPlay()
            ) {
                this.stopCoPlayResumeWatch();
                return;
            }
            if (!audio.paused) {
                // 已续上（可能是回抢成功 / 用户点了播放）
                this.stopCoPlayResumeWatch();
                return;
            }
            if (Date.now() - startedAt > 45000) {
                this.stopCoPlayResumeWatch();
                console.warn("[trackPlayer] 共播续播巡逻超时，保持暂停");
                return;
            }
            audio.play().catch(() => {
                // 仍被焦点占用 / 自动播放拦截：等下一轮
            });
            delay = Math.min(delay * 2, 2000);
            this.coPlayResumeTimer = setTimeout(attempt, delay);
        };
        this.coPlayResumeTimer = setTimeout(attempt, delay);
        document.addEventListener("visibilitychange", this.coPlayResumeOnVisible);
    }

    private coPlayResumeOnVisible = () => {
        if (document.visibilityState === "visible" && this.coPlayResumeTimer) {
            // 回前台立刻补一次，别干等被节流的 interval
            const audio = this.audio;
            if (audio?.paused && audio.src && !this.userPaused && getAllowCoPlay()) {
            audio.play().catch(() => {
                // 失败无妨，定时器还在巡逻
            });
            }
        }
    };

    private stopCoPlayResumeWatch() {
        if (this.coPlayResumeTimer) {
            clearTimeout(this.coPlayResumeTimer);
            this.coPlayResumeTimer = null;
        }
        document.removeEventListener("visibilitychange", this.coPlayResumeOnVisible);
    }

    private onAudioPlay = () => {
        // 「play」只代表已请求播放：换歌解析在途时不抢状态（由 beginLoading/cancelLoading 管）；
        // 数据没跟上（readyState < 3）也保持加载转圈，等真正出声的「playing」事件再切播放态，
        // 否则播放键会在 转圈↔暂停 之间来回抖。
        if (this.isLoading) {
            return;
        }
        const audio = this.audio;
        if (audio && audio.src && audio.readyState < 3) {
            setAtom(musicStateAtom, "loading");
            return;
        }
        setAtom(musicStateAtom, "playing");
        this.syncMediaSessionState();
    };

    private onAudioPlaying = () => {
        if (this.isLoading) {
            // 换歌解析在途：旧音源排队的迟到事件不抢状态
            return;
        }
        this.clearStallWatch();
        this.isLoading = false;
        this.autoSkipCount = 0;
        this.qualityRetryCount = 0;
        this.reconnectCount = 0;
        setAtom(musicStateAtom, "playing");
        this.syncMediaSessionState();
    };

    /**
     * 网络断流自救：同一直链原地重挂并从断点续播（异步进行，不阻塞 error 处理）。
     * 返回 true 表示本次失败已由重连接管。本地文件没有网络因素，不参与。
     */
    private tryReconnectStream(): boolean {
        const audio = this.audio;
        const music = this._currentMusic;
        const src = audio?.src;
        if (!audio || !src || !music || this.reconnecting) {
            return false;
        }
        if (music.localPath || this.playedFromLocalDownload) {
            return false;
        }
        if (this.reconnectCount >= MAX_STREAM_RECONNECT) {
            return false;
        }
        this.reconnectCount += 1;
        this.reconnecting = true;
        const playId = this.pendingPlayId;
        const position = audio.currentTime || 0;
        void (async () => {
            try {
                console.warn(
                    `[trackPlayer] 音频流中断，原地重连第 ${this.reconnectCount} 次（${position.toFixed(1)}s 处）`,
                );
                audio.src = src;
                audio.load();
                this.applyStartPosition(audio, position);
                await audio.play();
                console.warn("[trackPlayer] 断流重连成功");
            } catch {
                // 重连失败且期间没有新的播放请求：交回原失败链（降级 / 跳歌）兜底
                if (this.pendingPlayId === playId && this.audio === audio) {
                    await this.handlePlayFailure(music, "音频流网络中断（重连失败）");
                }
            } finally {
                this.reconnecting = false;
            }
        })();
        return true;
    }

    private onAudioError = async () => {
        const err = this.audio?.error;
        console.warn(`[trackPlayer] media error code=${err?.code} message=${err?.message}`);
        if (!this._currentMusic || !this.audio?.src) {
            return;
        }
        // 播放中的网络断流（熄屏 WiFi 休眠 / 系统省电限网）：先原地重连续播，
        // 不直接走「降级→跳歌」失败链，一次网络抖动不至于打断整队听歌。
        // 只救网络类错误（2）；链接失效（4）、解码失败（3）重连也没用。
        if (err?.code === 2 && this.tryReconnectStream()) {
            return;
        }
        await this.handlePlayFailure(this._currentMusic, describeMediaError(err));
    };

    /** 断掉当前音源并静音 */
    private detachAudio() {
        this.abortQualitySwitch();
        this.clearStallWatch();
        this.clearPendingSeek();
        const audio = this.audio;
        if (!audio) {
            return;
        }
        if (!audio.paused) {
            this.internalPausePending = true;
        }
        audio.pause();
        audio.removeAttribute("src");
        try {
            audio.load();
        } catch {
            // ignore
        }
    }

    /** 作废在途的音质预取（换歌、手动暂停、又点了一次切换都会走到这里） */
    private abortQualitySwitch() {
        this.qualitySwitchSeq += 1;
        if (this.probeAudio) {
            this.destroyAudioElement(this.probeAudio);
            this.probeAudio = null;
        }
        setAtom(qualitySwitchingAtom, null);
    }

    private clearPendingSeek() {
        if (this.pendingSeekListener) {
            this.audio?.removeEventListener("loadedmetadata", this.pendingSeekListener);
            this.pendingSeekListener = null;
        }
    }

    /** 把播放位置摆到目标处（HAVE_NOTHING 时赋值会成为「默认起播位置」） */
    private applyStartPosition(audio: AudioBackend, position: number) {
        if (!(position > 0) || !Number.isFinite(position)) {
            return;
        }
        this.clearPendingSeek();
        const seek = () => {
            try {
                audio.currentTime = position;
            } catch {
                // ignore
            }
        };
        seek();
        if (audio.readyState >= 1) {
            return;
        }
        const listener = () => {
            this.pendingSeekListener = null;
            if (Math.abs((audio.currentTime || 0) - position) > 2) {
                seek();
            }
        };
        this.pendingSeekListener = listener;
        audio.addEventListener("loadedmetadata", listener, { once: true });
    }

    /** 进入"解析音源中"：立刻静音旧歌，状态置为 loading */
    private beginLoading() {
        this.isLoading = true;
        this.detachAudio();
        setAtom(playingQualityAtom, null);
        if (this._currentMusic) {
            setAtom(musicStateAtom, "loading");
        }
    }

    /** 取消在途的加载（用户按暂停，或被一次新的换歌请求取代） */
    private cancelLoading() {
        this.pendingPlayId = "";
        this.isLoading = false;
        this.detachAudio();
        setAtom(musicStateAtom, this._currentMusic ? "paused" : "stopped");
    }

    /** 还能往下降的下一档音质 */
    private lowerQualityForRetry(musicItem: IMusic.IMusicItem): IMusic.IQualityKey | null {
        if (musicItem.localPath) {
            return null;
        }
        const used = this.resolvedQuality;
        if (!used) {
            return null;
        }
        const idx = QUALITY_LADDER.indexOf(used);
        return idx > 0 ? QUALITY_LADDER[idx - 1] : null;
    }

    /** 播放失败：先在本曲内按音质降级自救，救不了再自动往后跳一首 */
    private async handlePlayFailure(
        musicItem: IMusic.IMusicItem,
        rawReason: string,
        options?: { allowQualityRetry?: boolean },
    ) {
        const reason = rawReason || "未知原因";
        this.isLoading = false;
        const retryPosition = this.audio?.currentTime || 0;
        this.detachAudio();

        // 本地下载文件播放失败（文件损坏 / WebView 读不了等）：从失败位置改走线上音源，
        // 并把这首记进 bypass，本次会话内不再反复尝试本地
        if (this.playedFromLocalDownload) {
            this.playedFromLocalDownload = false;
            this.localDownloadBypass.add(playListKey(musicItem));
            console.warn(`[trackPlayer] 本地下载文件播放失败（${reason}），改走线上音源`);
            this.pendingStartPosition = retryPosition;
            await this.play(musicItem, true, this.isInPlayList(musicItem));
            return;
        }

        const lowerQuality =
            options?.allowQualityRetry === false ? null : this.lowerQualityForRetry(musicItem);
        if (lowerQuality && this.qualityRetryCount < MAX_QUALITY_RETRY) {
            this.qualityRetryCount += 1;
            console.warn(
                `[trackPlayer] 播放失败：${musicItem.title}（${reason}），降级为 ${lowerQuality} 重试`,
            );
            this.pendingStartPosition = retryPosition;
            this.emit(TrackPlayerEvents.PlayFailed, {
                musicItem,
                reason,
                willSkip: false,
                downgradedTo: lowerQuality,
            } as IPlayFailurePayload);
            this.qualityRetrying = true;
            try {
                await this.play(musicItem, true, this.isInPlayList(musicItem), lowerQuality);
            } finally {
                this.qualityRetrying = false;
            }
            return;
        }

        const willSkip = this.autoSkipCount < MAX_AUTO_SKIP && this._playList.length > 1;
        this.emit(TrackPlayerEvents.PlayFailed, { musicItem, reason, willSkip } as IPlayFailurePayload);

        if (!willSkip) {
            setAtom(musicStateAtom, this._currentMusic ? "paused" : "stopped");
            return;
        }
        this.autoSkipCount += 1;
        this.autoSkipping = true;
        try {
            await this.skipToNext();
        } finally {
            this.autoSkipping = false;
        }
    }

    private onEnded = async () => {
        if (!this._currentMusic) {
            return;
        }
        // 下一首已预加载好：直接交接，跳过「解析音源 + 重新加载」的空隙
        if (await this.tryCommitPreloadedNext()) {
            return;
        }
        if (this.pendingNextIndex() >= 0) {
            await this.skipToNext();
            return;
        }
        if (this._repeatMode === "single") {
            const audio = this.audio;
            if (!audio) {
                return;
            }
            if (!audio.src) {
                await this.play(this._currentMusic, true);
                return;
            }
            audio.currentTime = 0;
            audio.play().catch((e) =>
                console.warn("[trackPlayer] repeat-single failed", e?.name ?? e),
            );
            return;
        }
        if (this._playList.length === 0) {
            this.emit(TrackPlayerEvents.PlayEnd);
            setAtom(musicStateAtom, "stopped");
            this.clearMediaSession();
            return;
        }
        const index = this.getMusicIndexInPlayList(this._currentMusic);
        if (
            index === this._playList.length - 1 &&
            this._repeatMode === "off" &&
            this._playList.length > 1
        ) {
            this.emit(TrackPlayerEvents.PlayEnd);
            setAtom(musicStateAtom, "stopped");
            this.clearMediaSession();
            return;
        }
        await this.skipToNext();
    };

    /** ---------- 下一首预加载 ---------- */

    /**
     * 按换歌语义算出「接下来会播的那首」：待播（下一首播放）优先，其次队列顺序，
     * 与 onEnded / skipToNext 的取歌规则一致。没有下一首（队列空 / 单曲列表外的
     * repeat off 收尾）返回 null。单曲循环交给 audio.loop，不参与预加载。
     */
    private async computeNextMusicItem(): Promise<IMusic.IMusicItem | null> {
        const pendingIndex = this.pendingNextIndex();
        if (pendingIndex >= 0) {
            return this._playList[pendingIndex];
        }
        if (!this._playList.length) {
            return null;
        }
        // repeat off 的队尾歌播完就停（onEnded 里会走 PlayEnd），不算有下一首
        const curIndex = this.getMusicIndexInPlayList(this._currentMusic);
        if (
            curIndex === this._playList.length - 1 &&
            this._repeatMode === "off" &&
            this._playList.length > 1
        ) {
            return null;
        }
        const nextIndex = await this.getNextIndex(1);
        return nextIndex >= 0 ? this._playList[nextIndex] : null;
    }

    /** 结尾窗口触发预加载：remaining 已在 onProgress 算好（Infinity = 时长未知） */
    private maybeStartNextTrackPreload(remaining: number) {
        if (this.nextPreload || this.preloadStarting || this.isLoading) {
            return;
        }
        if (this._repeatMode === "single" || !this._currentMusic || !this.audio?.src) {
            return;
        }
        if (remaining > NEXT_PRELOAD_AHEAD || remaining <= 0.3) {
            return;
        }
        this.preloadStarting = true;
        void this.startNextTrackPreload();
    }

    /** 预加载流程：解析下一首音源 → 判缓存 → 按后端决定 append 播放列表或开预缓冲元素 */
    private async startNextTrackPreload() {
        const seq = ++this.nextPreloadSeq;
        try {
            const next = await this.computeNextMusicItem();
            if (seq !== this.nextPreloadSeq) {
                return;
            }
            if (!next) {
                return;
            }
            // 这首的预加载刚失败过：冷却期内不再撞同一个坏音源
            if (
                this.preloadFailedKey === playListKey(next) &&
                Date.now() - this.preloadFailedAt < NEXT_PRELOAD_RETRY_AFTER
            ) {
                return;
            }
            const preload: INextTrackPreload = {
                musicItem: next,
                resolved: null,
                playSrc: null,
                probe: null,
                appended: false,
            };
            this.nextPreload = preload;
            console.info(`[trackPlayer] 预加载下一首：${next.title}`);
            const resolved = await this.resolveMediaUrl(next);
            if (seq !== this.nextPreloadSeq || this.nextPreload !== preload) {
                return;
            }
            if (!resolved.ok) {
                this.nextPreload = null;
                this.preloadFailedKey = playListKey(next);
                this.preloadFailedAt = Date.now();
                console.warn(`[trackPlayer] 预加载下一首失败：${resolved.reason}`);
                return;
            }
            preload.resolved = resolved;
            let playSrc = resolved.src;
            if (!next.localPath && !resolved.localDownload) {
                // 与 play() 同规则：命中播放缓存直接用本地文件（交接后即秒开）；
                // 未命中顺路把整首后台缓存，本次预缓冲与下次播放都受益
                const cached = await lookupCachedSrc(next, resolved.quality);
                if (seq !== this.nextPreloadSeq || this.nextPreload !== preload) {
                    return;
                }
                if (cached) {
                    playSrc = cached;
                } else {
                    requestAudioCacheStore(next, resolved.quality, resolved.source);
                }
            }
            preload.playSrc = playSrc;
            const audio = this.audio;
            if (!audio) {
                this.nextPreload = null;
                return;
            }
            if (audio instanceof NativeAudioElement) {
                // ExoPlayer 播放列表：当前曲目播完自动无缝续播，无需 JS 干预
                try {
                    await audio.appendNextSource(playSrc);
                } catch (e: any) {
                    console.warn("[trackPlayer] 追加预载曲目失败", e?.message ?? e);
                    this.nextPreload = null;
                    return;
                }
                if (seq !== this.nextPreloadSeq || this.nextPreload !== preload) {
                    audio.clearNextSources();
                    return;
                }
                preload.appended = true;
            } else {
                const probe: AudioBackend = new Audio();
                probe.preload = "auto";
                preload.probe = probe;
                probe.src = playSrc;
                this.monitorPreloadProbe(probe, seq, preload);
            }
        } finally {
            this.preloadStarting = false;
        }
    }

    /**
     * 盯着预缓冲元素：缓冲够开头几秒就算就绪（ended 交接时不再等待）；
     * 迟迟没数据且主播放器在播时静音催一下流（iOS 不理未开播元素的 preload）；
     * 加载失败就整体作废，ended 时走原有换歌链路兜底。
     */
    private monitorPreloadProbe(probe: AudioBackend, seq: number, preload: INextTrackPreload) {
        const startedAt = Date.now();
        let kicked = false;
        const timer = setInterval(() => {
            if (seq !== this.nextPreloadSeq || this.nextPreload !== preload) {
                // 已作废：probe 由 abortNextTrackPreload 统一销毁
                clearInterval(timer);
                return;
            }
            if (probe.error) {
                clearInterval(timer);
                console.warn("[trackPlayer] 预加载的下一首缓冲失败，放弃预加载");
                this.abortNextTrackPreload();
                return;
            }
            const duration = probe.duration;
            const lead = Number.isFinite(duration) && duration > 0
                ? Math.min(NEXT_PRELOAD_PROBE_LEAD, duration)
                : NEXT_PRELOAD_PROBE_LEAD;
            if (probe.readyState >= 3 && bufferedEndAfter(probe, 0) >= lead - 0.1) {
                clearInterval(timer);
                return;
            }
            const main = this.audio;
            if (
                !kicked &&
                Date.now() - startedAt >= NEXT_PRELOAD_KICK_DELAY &&
                main &&
                !main.paused &&
                !main.error
            ) {
                kicked = true;
                probe.volume = 0;
                probe.play().catch(() => {
                    // 催不动就算了，preload 还在拉流
                });
            }
        }, NEXT_PRELOAD_POLL);
    }

    /**
     * 作废在途预加载：队列变动 / 换歌 / 换音质 / 改重复模式都会走到这里。
     * 原生后端要把 append 进播放列表的曲目一并撤下，否则 ExoPlayer 会在
     * 当前曲播完自动续播一首 JS 侧已经不认的歌。
     */
    abortNextTrackPreload() {
        this.nextPreloadSeq += 1;
        const preload = this.nextPreload;
        this.nextPreload = null;
        if (preload?.probe) {
            this.destroyAudioElement(preload.probe);
        }
        if (preload?.appended && this.audio instanceof NativeAudioElement) {
            this.audio.clearNextSources();
        }
    }

    /**
     * WebView 后端的歌播完了：预缓冲元素若可用就交接，否则走原有链路。
     * 复核一遍取歌语义（队列可能刚变过），对不上就作废预加载。
     */
    private async tryCommitPreloadedNext(): Promise<boolean> {
        const preload = this.nextPreload;
        // appended 的曲目由 ExoPlayer 自动续播，播完不会产生 ended 事件
        if (!preload?.playSrc || preload.appended || !preload.probe) {
            return false;
        }
        const next = await this.computeNextMusicItem();
        // 等待期间用户手动换了歌 / 队列又变了：让位，走常规链路
        if (this.nextPreload !== preload) {
            return false;
        }
        if (!next || playListKey(next) !== playListKey(preload.musicItem)) {
            this.abortNextTrackPreload();
            return false;
        }
        await this.commitPreloadedNext(preload);
        return true;
    }

    /**
     * 原生后端：ExoPlayer 播完当前曲自动续播了预载的下一首（index >= 1）。
     * 声音已经接上了，这里只做换歌簿记，让 JS 侧状态跟上播放器的现实。
     */
    private onItemTransition = async (ev: any) => {
        const index = Number(ev?.index) || 0;
        if (index < 1) {
            return; // setSource / 队列操作引起的过渡，不是自动续播
        }
        const preload = this.nextPreload;
        if (!preload?.appended) {
            // 理论不达（append 与作废配对管理）：兜底按 ended 处理，重新对齐状态
            console.warn("[trackPlayer] 收到非预期的曲目过渡，按换歌兜底处理");
            await this.onEnded();
            return;
        }
        await this.commitPreloadedNext(preload);
    };

    /**
     * 交接预载的下一首：簿记与 play() 的换歌分支一致（队列 / 历史 / atom /
     * 媒体会话），音频侧两条后端不同——原生已在播新曲，只翻状态；WebView
     * 把预缓冲元素扶正为主播放器再开播。
     */
    private async commitPreloadedNext(preload: INextTrackPreload) {
        this.nextPreload = null;
        this.nextPreloadSeq += 1;
        const target = preload.musicItem;
        const playId = `${target.platform}-${target.id}-${Date.now()}-${++this.playSeq}`;
        this.pendingPlayId = playId;

        this.stallNudges = 0;
        this.pendingStartPosition = 0;
        this.userPaused = false;
        this.coPlayResumeSeq += 1;
        this.stopCoPlayResumeWatch();
        if (!this.isInPlayList(target)) {
            this.add(target);
        }
        this._currentMusic = target;
        this.consumePendingNext(target);
        this.pushHistory(target);
        setAtom(currentMusicAtom, target);
        this.emit(TrackPlayerEvents.CurrentMusicChanged, target);
        setMusicHistory(target);
        this.persistPlayList();
        setAtom(progressAtom, { position: 0, duration: target.duration ?? 0 });
        this.resolvedQuality = preload.resolved?.quality ?? null;
        this.resolvedSourceUrl = preload.resolved?.source?.url ?? null;
        this.playedFromLocalDownload = !!preload.resolved?.localDownload;
        setAtom(playingQualityAtom, preload.resolved?.quality ?? null);
        this.clearStallWatch();
        this.clearPendingSeek();
        await this.updateMediaSession(target);
        // 簿记期间用户手动点了播放（playId 已被取代）：交出控制权
        if (this.pendingPlayId !== playId) {
            return;
        }

        if (preload.appended) {
            // 原生后端：ExoPlayer 已经在出声，簿记完成即无缝换歌成功。
            // 过渡不产生 playing 事件，重试计数器在这里手工清零（WebView 路径由
            // onAudioPlaying 统一清）
            this.isLoading = false;
            this.autoSkipCount = 0;
            this.qualityRetryCount = 0;
            this.reconnectCount = 0;
            setAtom(musicStateAtom, "playing");
            return;
        }

        // WebView 后端：预缓冲元素接棒。数据已缓冲好，交接只是换实例 + 起播
        const probe = preload.probe!;
        const old = this.audio;
        if (old) {
            this.destroyAudioElement(old);
        }
        this.audio = probe;
        this.attachAudioListeners(probe);
        probe.volume = getStoredVolume();
        probe.muted = false;
        probe.playbackRate = this._rate;
        probe.loop = this._repeatMode === "single";
        try {
            probe.currentTime = 0;
        } catch {
            // ignore
        }
        this.isLoading = false;
        try {
            await probe.play();
        } catch (e: any) {
            console.warn("[trackPlayer] 预载交接起播失败，回退常规换歌", e?.name ?? e);
            await this.play(target, true, this.isInPlayList(target));
            return;
        }
        setAtom(musicStateAtom, "playing");
    }

    /** ---------- 播放列表管理 ---------- */
    get playList() {
        return this._playList;
    }
    get currentMusic() {
        return this._currentMusic;
    }
    get repeatMode() {
        return this._repeatMode;
    }

    private persistPlayList() {
        const slim = (item: IMusic.IMusicItem): IMusic.IMusicItem =>
            typeof item.artwork === "string" && item.artwork.length > MAX_PERSISTED_ARTWORK
                ? { ...item, artwork: "" }
                : item;
        try {
            localStorage.setItem(
                "playList",
                JSON.stringify(this._playList.slice(0, 500).map(slim)),
            );
            if (this._currentListId) {
                localStorage.setItem("currentListId", this._currentListId);
            } else {
                localStorage.removeItem("currentListId");
            }
            if (this._currentMusic) {
                localStorage.setItem("currentMusic", JSON.stringify(slim(this._currentMusic)));
            } else {
                localStorage.removeItem("currentMusic");
            }
        } catch {
            // localStorage 写满等异常不影响播放
        }
    }

    getMusicIndexInPlayList(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem) {
            return -1;
        }
        return this._playList.findIndex(
            (it) => it.id === musicItem.id && it.platform === musicItem.platform,
        );
    }

    /**
     * 播放期间曲目的展示元数据被外部更新（本地音乐匹配到歌词 / 封面）时同步进来：
     * 替换当前曲目与队列里的同曲目条目并落盘，不影响音频播放。
     * currentMusic 换新对象还会驱动播放页重载歌词。
     */
    updateMusicItemMeta(item: IMusic.IMusicItem) {
        const sameKey = (a?: IMusic.IMusicItem | null) =>
            !!a && a.id === item.id && a.platform === item.platform;
        let touched = false;
        if (sameKey(this._currentMusic)) {
            this._currentMusic = { ...this._currentMusic!, ...item };
            setAtom(currentMusicAtom, this._currentMusic);
            touched = true;
        }
        if (this.getMusicIndexInPlayList(item) >= 0) {
            this._playList = this._playList.map((it) =>
                it.id === item.id && it.platform === item.platform ? { ...it, ...item } : it,
            );
            setAtom(playListAtom, this._playList);
            touched = true;
        }
        if (touched) {
            this.persistPlayList();
        }
    }

    isInPlayList(musicItem?: IMusic.IMusicItem | null) {
        return this.getMusicIndexInPlayList(musicItem) >= 0;
    }

    isPlayListEmpty() {
        return this._playList.length === 0;
    }

    private notifyPlayListAdded() {
        setAtom(playListAddedAtom, store.get(playListAddedAtom) + 1);
    }

    /** 追加到播放队列。已经在队列里的歌不会再塞一份（按 platform+id 认）。 */
    addAll(
        musicItems: IMusic.IMusicItem[],
        beforeIndex?: number,
        shouldShuffle?: boolean,
    ): number {
        // 队列变动可能改变「下一首」，在途预加载作废（仍在结尾窗口的话下个 timeupdate 重来）
        this.abortNextTrackPreload();
        const inQueue = new Set(this._playList.map(playListKey));
        const valid = toQueueableList(musicItems).filter((it) => !inQueue.has(playListKey(it)));
        const list = [...this._playList];
        const insertAt = beforeIndex === undefined ? list.length : beforeIndex;
        if (shouldShuffle) {
            valid.sort(() => Math.random() - 0.5);
        }
        list.splice(insertAt, 0, ...valid);
        this._playList = list;
        setAtom(playListAtom, this._playList);
        if (valid.length) {
            this.notifyPlayListAdded();
        }
        this.persistPlayList();
        return valid.length;
    }

    add(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        return this.addAll(items, beforeIndex);
    }

    /** 插到当前这首之后，并登记为待播（随机/单曲循环下也能保证播出） */
    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        const keys = new Set(items.filter(isQueueable).map(playListKey));
        if (keys.size) {
            this._playList = this._playList.filter((it) => !keys.has(playListKey(it)));
        }
        const currentIndex = this.getMusicIndexInPlayList(this._currentMusic);
        const added = this.addAll(items, currentIndex + 1);
        this.declarePendingNext(items);
        return added;
    }

    private declarePendingNext(musicItems: IMusic.IMusicItem[]) {
        for (const musicItem of musicItems) {
            const key = playListKey(musicItem);
            if (
                !isQueueable(musicItem) ||
                this.isCurrentMusic(musicItem) ||
                this._pendingNext.includes(key)
            ) {
                continue;
            }
            this._pendingNext.push(key);
        }
    }

    private consumePendingNext(musicItem: IMusic.IMusicItem) {
        const key = playListKey(musicItem);
        const at = this._pendingNext.indexOf(key);
        if (at >= 0) {
            this._pendingNext.splice(at, 1);
        }
    }

    private pendingNextIndex() {
        for (const key of this._pendingNext) {
            const index = this._playList.findIndex((it) => playListKey(it) === key);
            if (index >= 0) {
                return index;
            }
        }
        return -1;
    }

    async remove(musicItem: IMusic.IMusicItem) {
        const index = this.getMusicIndexInPlayList(musicItem);
        if (index < 0) {
            return;
        }
        this.abortNextTrackPreload();
        const removingCurrent = this.isCurrentMusic(musicItem);
        const list = [...this._playList];
        list.splice(index, 1);
        this._playList = list;
        setAtom(playListAtom, this._playList);
        this.persistPlayList();
        this.consumePendingNext(musicItem);
        if (removingCurrent) {
            if (list.length === 0) {
                await this.clearPlayListAndStop();
            } else {
                await this.play(list[Math.min(index, list.length - 1)], true);
            }
        }
    }

    isCurrentMusic(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem || !this._currentMusic) {
            return false;
        }
        return (
            musicItem.id === this._currentMusic.id &&
            musicItem.platform === this._currentMusic.platform
        );
    }

    /** 拖拽排序：把 from 位置的歌移到 to 位置，不影响正在播放 */
    reorderMusic(from: number, to: number) {
        const len = this._playList.length;
        if (from === to || from < 0 || from >= len || to < 0 || to >= len) {
            return;
        }
        this.abortNextTrackPreload();
        const list = [...this._playList];
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        this._playList = list;
        setAtom(playListAtom, list);
        this.persistPlayList();
    }

    /** 清空播放队列，正在播的这首继续播 */
    clearPlayList() {
        this.abortNextTrackPreload();
        this._playList = [];
        setAtom(playListAtom, []);
        this._pendingNext = [];
        this.persistPlayList();
    }

    /** 清空队列并且彻底停下 */
    async clearPlayListAndStop() {
        this._currentMusic = null;
        this.pendingPlayId = "";
        this.isLoading = false;
        this.autoSkipCount = 0;
        setAtom(currentMusicAtom, null);
        setAtom(musicStateAtom, "stopped");
        setAtom(progressAtom, { position: 0, duration: 0 });
        setAtom(playingQualityAtom, null);
        this.detachAudio();
        this.clearMediaSession();
        this.clearPlayList();
        this._history = [];
        try {
            localStorage.removeItem("playProgress");
        } catch {
            // ignore
        }
    }

    /** ---------- 播放控制 ---------- */

    /**
     * 解析可播放音源。音质按 resolveQualityLadder 从请求档逐级下降尝试。
     * 找不到可用音源时返回带人话原因的失败（插件缺失 / 被禁用 / 挂载失败是恢复备份后最常见的几种）。
     * 除播放外，下载模块也用它取直链（source.url 原始地址 + 自定义请求头）。
     * 本地音乐（带 localPath）不走插件，直接转 WebView 可访问的文件地址。
     * 已下载的歌（下载记录里有可播放文件）同样优先播本地：经 musicDownload 注册的
     * 解析器拿本地地址，不再请求线上；下载取直链时传 ignoreLocalDownload 跳过这层。
     */
    async resolveMediaUrl(
        musicItem: IMusic.IMusicItem,
        qualityOverride?: IMusic.IQualityKey,
        excludeUrl?: string,
        opts?: { ignoreLocalDownload?: boolean },
    ): Promise<
        | {
              ok: true;
              src: string;
              source?: IPlugin.IMediaSourceResult;
              quality: IMusic.IQualityKey | null;
              /** 音源来自下载到本机的文件（播放失败兜底与音质切换按 localPath 同规则处理） */
              localDownload?: true;
          }
        | { ok: false; reason: string }
    > {
        if (musicItem.localPath) {
            return {
                ok: true,
                src: localFileUrl(musicItem.localPath),
                source: { url: musicItem.localPath },
                quality: null,
            };
        }
        // 已下载的歌直接播本地文件：断网可播、秒开、不耗流量（插件缺失也不影响）
        if (!opts?.ignoreLocalDownload && !this.localDownloadBypass.has(playListKey(musicItem))) {
            const local = await downloadedSourceResolver?.(musicItem);
            if (local) {
                return { ok: true, src: local.src, quality: local.quality, localDownload: true };
            }
        }
        const plugins = await getPlugins();
        const samePlatform = plugins.filter((p) => p.platform === musicItem.platform);
        if (!samePlatform.length) {
            return {
                ok: false,
                reason: `未找到平台「${musicItem.platform}」的音源插件，请先安装（备份恢复后在插件管理里确认）`,
            };
        }
        const plugin = samePlatform.find((p) => p.enabled && p.state === "Mounted");
        if (!plugin) {
            const broken = samePlatform[0];
            return {
                ok: false,
                reason: !broken.enabled
                    ? `音源「${broken.platform}」已被禁用，请在插件管理里启用`
                    : `音源「${broken.platform}」未能加载（${broken.errorReason ?? "未知原因"}），请更新或重装插件`,
            };
        }
        if (plugin.supportedMethods.includes("getMediaSource")) {
            const requested =
                qualityOverride ??
                pickSupportedQuality(getQuality(), musicItem.qualities) ??
                getQuality();
            for (const quality of resolveQualityLadder(requested)) {
                try {
                    const source = (await Promise.race([
                        pluginCall(
                            plugin.hash,
                            "getMediaSource",
                            musicItem,
                            quality,
                        ) as Promise<IPlugin.IMediaSourceResult | null>,
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () => reject(new Error("音源响应超时")),
                                MEDIA_SOURCE_TIMEOUT,
                            ),
                        ),
                    ])) as IPlugin.IMediaSourceResult | null;
                    if (source?.url) {
                        if (source.url === excludeUrl) {
                            console.warn(`[trackPlayer] ${quality} 返回的直链与刚失败的相同，跳过`);
                            continue;
                        }
                        return {
                            ok: true,
                            src: buildPlayableMediaUrl({
                                url: source.url,
                                headers: source.headers,
                                userAgent: source.userAgent,
                            }),
                            source,
                            quality,
                        };
                    }
                } catch (e: any) {
                    console.warn(`[trackPlayer] getMediaSource failed (${quality}):`, e?.message ?? e);
                }
            }
        }
        if (musicItem.url) {
            if (musicItem.url === excludeUrl) {
                return { ok: false, reason: `音源「${plugin.platform}」没有返回可播放的链接` };
            }
            return {
                ok: true,
                src: buildPlayableMediaUrl({ url: musicItem.url }),
                source: { url: musicItem.url },
                quality: null,
            };
        }
        return { ok: false, reason: `音源「${plugin.platform}」没有返回可播放的链接` };
    }

    private async updateMediaSession(musicItem: IMusic.IMusicItem) {
        if ("mediaSession" in navigator) {
            let artwork: string | undefined = musicItem.artwork;
            if (artwork && artwork.length > MAX_PERSISTED_ARTWORK) {
                artwork = undefined;
            }
            navigator.mediaSession.metadata = new MediaMetadata({
                title: musicItem.title,
                artist: musicItem.artist,
                album: musicItem.album,
                artwork: artwork ? [{ src: artwork, sizes: "512x512" }] : [],
            });
            navigator.mediaSession.setActionHandler("play", () => this.resume());
            navigator.mediaSession.setActionHandler("pause", () => this.pause());
            navigator.mediaSession.setActionHandler("previoustrack", () => this.skipToPrevious());
            navigator.mediaSession.setActionHandler("nexttrack", () => this.skipToNext());
            navigator.mediaSession.setActionHandler("seekto", (details: any) => {
                const target = details?.seekTime;
                if (typeof target === "number" && Number.isFinite(target)) {
                    this.seekTo(target);
                }
            });
        }
    }

    /**
     * 把「听到哪儿」同步进 Web MediaSession（iOS 锁屏 / 控制中心、桌面浏览器的
     * 媒体键浮层靠它显示进度）。Android 原生走 mediaNotification 通道，用不到它。
     */
    private syncMediaSessionState() {
        if (!("mediaSession" in navigator)) {
            return;
        }
        const audio = this.audio;
        if (!audio?.src) {
            return;
        }
        try {
            const duration =
                Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration
                    : this._currentMusic?.duration ?? 0;
            if (!duration) {
                return;
            }
            navigator.mediaSession.setPositionState({
                duration,
                position: Math.min(Math.max(audio.currentTime || 0, 0), duration),
                playbackRate: audio.playbackRate || 1,
            });
            navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
        } catch {
            // ignore
        }
    }

    /** 彻底停了（队列播完 / 清空）：把系统媒体会话一并收掉 */
    private clearMediaSession() {
        if (!("mediaSession" in navigator)) {
            return;
        }
        try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
        } catch {
            // ignore
        }
    }

    async play(
        musicItem?: IMusic.IMusicItem | null,
        forcePlay?: boolean,
        addToPlayList = true,
        qualityOverride?: IMusic.IQualityKey,
    ) {
        if (!musicItem && !this._currentMusic) {
            return;
        }
        const target = musicItem ?? this._currentMusic!;
        // 新的播放请求取代一切在途预加载（原生后端撤下已 append 的曲目）
        this.abortNextTrackPreload();
        const playId = `${target.platform}-${target.id}-${Date.now()}-${++this.playSeq}`;
        this.pendingPlayId = playId;

        const isNew = !this.isCurrentMusic(target);
        const willLoad = isNew || !!forcePlay;
        const resumePosition = this.isCurrentMusic(target) ? this.pendingStartPosition : 0;

        if (!this.autoSkipping && !this.qualityRetrying) {
            this.autoSkipCount = 0;
            this.qualityRetryCount = 0;
        }

        if (isNew) {
            this.stallNudges = 0;
            this.pendingStartPosition = 0;
            this.userPaused = false;
            // 换歌：旧歌的共播续播巡逻作废
            this.coPlayResumeSeq += 1;
            this.stopCoPlayResumeWatch();
            if (addToPlayList && !this.isInPlayList(target)) {
                this.add(target);
            }
            this._currentMusic = target;
            this.consumePendingNext(target);
            this.pushHistory(target);
            setAtom(currentMusicAtom, target);
            this.emit(TrackPlayerEvents.CurrentMusicChanged, target);
            setMusicHistory(target);
            this.persistPlayList();
            setAtom(progressAtom, { position: resumePosition, duration: target.duration ?? 0 });
        }

        if (willLoad) {
            // 解析音源可能耗时很久，这一步就把上一首停掉
            this.beginLoading();
        }

        try {
            const resolved = await this.resolveMediaUrl(
                target,
                qualityOverride,
                qualityOverride ? (this.resolvedSourceUrl ?? undefined) : undefined,
            );
            if (this.pendingPlayId !== playId) {
                return;
            }
            if (!resolved.ok) {
                await this.handlePlayFailure(target, resolved.reason, {
                    allowQualityRetry: false,
                });
                return;
            }
            this.resolvedQuality = resolved.quality;
            this.resolvedSourceUrl = resolved.source?.url ?? null;
            this.playedFromLocalDownload = !!resolved.localDownload;
            setAtom(playingQualityAtom, resolved.quality);
            const audio = this.audio;
            if (!audio) {
                return;
            }
            let playSrc = resolved.src;
            if (!target.localPath && !resolved.localDownload) {
                // 播放缓存：命中直接读本地（秒开、省流量、断网可重听）；
                // 未命中先在线播，同时后台整首缓存，下次播放走本地
                const cached = await lookupCachedSrc(target, resolved.quality);
                if (this.pendingPlayId !== playId) {
                    return;
                }
                if (cached) {
                    playSrc = cached;
                } else {
                    requestAudioCacheStore(target, resolved.quality, resolved.source);
                }
            }
            audio.src = playSrc;
            audio.playbackRate = this._rate;
            this.syncLoopFlag();
            this.applyStartPosition(audio, resumePosition);
            this.pendingStartPosition = 0;
            await this.updateMediaSession(target);
            if (this.pendingPlayId !== playId) {
                return;
            }
            this.isLoading = false;
            await audio.play();
            if (this.pendingPlayId === playId) {
                setAtom(musicStateAtom, "playing");
            }
        } catch (e: any) {
            if (this.pendingPlayId !== playId) {
                return;
            }
            await this.handlePlayFailure(target, describePlayError(e));
        }
    }

    private resume() {
        const audio = this.audio;
        if (!audio) {
            return;
        }
        this.userPaused = false;
        if (!audio.src) {
            if (this._currentMusic) {
                this.play(this._currentMusic, true);
            }
            return;
        }
        audio.play().catch((e) => {
            console.warn("[trackPlayer] resume failed", e?.name ?? e);
            // 起播失败（典型是自动播放被拦截）：别让界面卡在「加载中」转圈
            if (!this.isLoading && store.get(musicStateAtom) === "loading") {
                setAtom(musicStateAtom, "paused");
            }
        });
    }

    async pause() {
        if (this.isLoading) {
            this.cancelLoading();
            return;
        }
        this.userPauseSeq += 1;
        // 用户主动暂停：作废在途的共播续播巡逻，别再替用户把歌抢回来
        this.coPlayResumeSeq += 1;
        this.stopCoPlayResumeWatch();
        const audio = this.audio;
        if (audio && !audio.paused) {
            // 只有真的在播才有 pause 事件，标记也别留到下一次外部暂停上
            this.internalPausePending = true;
        }
        this.userPaused = true;
        audio?.pause();
        // 预载保留（恢复播放后还能无缝续上），但静音催播的预缓冲元素跟着停
        const probe = this.nextPreload?.probe;
        if (probe && !probe.paused) {
            probe.pause();
        }
        setAtom(musicStateAtom, "paused");
    }

    async togglePlay() {
        if (this.isLoading) {
            this.cancelLoading();
            return;
        }
        if (!this._currentMusic) {
            if (this._playList.length) {
                await this.play(this._playList[0]);
            }
            return;
        }
        if (this.audio && !this.audio.src) {
            await this.play(this._currentMusic, true);
            return;
        }
        if (this.audio?.paused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    private async getNextIndex(direction: 1 | -1): Promise<number> {
        const len = this._playList.length;
        if (!len) {
            return -1;
        }
        const curIndex = this.getMusicIndexInPlayList(this._currentMusic);
        if (this._repeatMode === "queue") {
            if (len === 1) {
                return curIndex;
            }
            let next = curIndex;
            while (next === curIndex) {
                next = Math.floor(Math.random() * len);
            }
            return next;
        }
        if (curIndex < 0) {
            return 0;
        }
        return (curIndex + direction + len) % len;
    }

    async skipToNext() {
        const pendingIndex = this.pendingNextIndex();
        if (pendingIndex >= 0) {
            await this.play(this._playList[pendingIndex], true);
            return;
        }
        const nextIndex = await this.getNextIndex(1);
        if (nextIndex >= 0) {
            await this.play(this._playList[nextIndex], true);
        }
    }

    private pushHistory(musicItem: IMusic.IMusicItem) {
        const last = this._history[this._history.length - 1];
        if (last && last.id === musicItem.id && last.platform === musicItem.platform) {
            return;
        }
        this._history.push(musicItem);
        if (this._history.length > MAX_HISTORY) {
            this._history = this._history.slice(-MAX_HISTORY);
        }
    }

    private takePreviousFromHistory() {
        const prev = this._history[this._history.length - 2];
        if (!prev) {
            return null;
        }
        if (this.isCurrentMusic(this._history[this._history.length - 1])) {
            this._history.pop();
        }
        return prev;
    }

    async skipToPrevious() {
        const prev = this.takePreviousFromHistory();
        if (prev) {
            await this.play(prev, true, this.isInPlayList(prev));
            return;
        }
        if (!this.isInPlayList(this._currentMusic)) {
            return;
        }
        const nextIndex = await this.getNextIndex(-1);
        if (nextIndex >= 0) {
            await this.play(this._playList[nextIndex], true);
        }
    }

    /** 「播放全部」从哪一首开始：随机模式下随机挑一首，否则第一首 */
    pickPlayAllStart(list: IMusic.IMusicItem[]) {
        if (this._repeatMode !== "queue" || list.length < 2) {
            return list[0];
        }
        return list[Math.floor(Math.random() * list.length)];
    }

    /** 整队替换并从这首开始播 */
    async playWithReplacePlayList(
        musicItem: IMusic.IMusicItem,
        newPlayList: IMusic.IMusicItem[],
        listId = "",
        forceReplace = false,
    ) {
        const alreadyThisList =
            !forceReplace &&
            !!listId &&
            this._currentListId === listId &&
            this.isInPlayList(musicItem);
        if (!alreadyThisList) {
            this._playList = toQueueableList(newPlayList);
            this._currentListId = listId;
            this._pendingNext = [];
            setAtom(playListAtom, this._playList);
            this.notifyPlayListAdded();
            this.persistPlayList();
        }
        await this.play(musicItem, true);
    }

    /** 单曲循环交给 audio.loop：播完无缝重头，消除 ended→seek(0)→play 的重新加载间隙 */
    private syncLoopFlag() {
        if (this.audio) {
            this.audio.loop = this._repeatMode === "single";
        }
    }

    toggleRepeatMode() {
        const order: MusicRepeatMode[] = ["off", "queue", "single"];
        const next = order[(order.indexOf(this._repeatMode) + 1) % order.length];
        this._repeatMode = next;
        this.abortNextTrackPreload();
        setAtom(repeatModeAtom, next);
        localStorage.setItem("repeatMode", next);
        this.syncLoopFlag();
    }

    async seekTo(position: number) {
        if (this.audio && Number.isFinite(this.audio.duration)) {
            this.audio.currentTime = position;
            setAtom(progressAtom, { position, duration: this.audio.duration || 0 });
            this.syncMediaSessionState();
            return;
        }
        if (this._currentMusic) {
            this.pendingStartPosition = position;
            setAtom(progressAtom, { position, duration: this._currentMusic.duration || 0 });
        }
    }

    async setRate(rate: number) {
        this._rate = rate;
        if (this.audio) {
            this.audio.playbackRate = rate;
        }
        setAtom(rateAtom, rate);
    }

    setVolume(volume: number) {
        const next = Math.min(Math.max(volume, 0), 1);
        if (this.audio) {
            this.audio.volume = next;
        }
        localStorage.setItem("volume", String(next));
        setAtom(volumeAtom, next);
    }

    getVolume() {
        return this.audio?.volume ?? getStoredVolume();
    }

    /**
     * 无缝切换音质：当前音源照常播放，另开一个播放器在后台把目标音质缓冲到
     * 「播放头之后 SEAMLESS_LEAD 秒」，够了才交接；解析或缓冲不给力就一直播旧的，
     * 所以切音质不会产生静音间隙（代价是切换失败时保持原音质）。
     */
    private async switchQualitySeamless(
        musicItem: IMusic.IMusicItem,
        targetQuality: IMusic.IQualityKey,
    ): Promise<IQualitySwitchResult> {
        this.abortQualitySwitch();
        const seq = ++this.qualitySwitchSeq;
        const isStale = () => seq !== this.qualitySwitchSeq;
        const livePosition = () => this.audio?.currentTime ?? 0;
        let probe: AudioBackend | null = null;
        let committed = false;
        setAtom(qualitySwitchingAtom, targetQuality);

        try {
            // excludeUrl：插件常拿同一个直链糊弄不同音质，换个 URL 才算真换；
            // 切音质永远解析线上（本地下载文件没有目标音质这一说）
            const resolved = await this.resolveMediaUrl(
                musicItem,
                targetQuality,
                this.resolvedSourceUrl ?? undefined,
                { ignoreLocalDownload: true },
            );
            if (isStale()) {
                return { status: "cancelled" };
            }
            if (!resolved.ok) {
                return { status: "failed", reason: resolved.reason };
            }

            // 只在 WebView 后端走到这（原生后端在 applyQuality 里已降级重挂），
            // 双 <audio> 预取是无缝交接的关键
            probe = new Audio();
            probe.preload = "auto";
            probe.playbackRate = this._rate;
            this.probeAudio = probe;
            let probeSrc = resolved.src;
            if (!musicItem.localPath) {
                // 目标音质命中缓存则从本地交接（切换近乎瞬时）；未命中顺路缓存该音质
                const cached = await lookupCachedSrc(musicItem, resolved.quality);
                if (isStale()) {
                    return { status: "cancelled" };
                }
                if (cached) {
                    probeSrc = cached;
                } else {
                    requestAudioCacheStore(musicItem, resolved.quality, resolved.source);
                }
            }
            probe.src = probeSrc;
            await this.waitForProbeBuffered(probe, livePosition, isStale);
            if (isStale()) {
                return { status: "cancelled" };
            }
            const result = this.commitQualitySwitch(probe, resolved);
            committed = true;
            return result;
        } catch (e: any) {
            if (isStale()) {
                return { status: "cancelled" };
            }
            console.warn(`[trackPlayer] 无缝切换 ${targetQuality} 失败:`, e?.message ?? e);
            return { status: "failed", reason: e?.message ?? "新音源准备失败" };
        } finally {
            if (!isStale()) {
                setAtom(qualitySwitchingAtom, null);
            }
            if (probe && !committed) {
                if (this.probeAudio === probe) {
                    this.probeAudio = null;
                }
                this.destroyAudioElement(probe);
            }
        }
    }

    /** 等预取播放器把播放头之后 SEAMLESS_LEAD 秒缓冲好（播放头会一直往前追） */
    private waitForProbeBuffered(
        probe: AudioBackend,
        livePosition: () => number,
        isStale: () => boolean,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            let settled = false;
            let lastSeekAt = 0;
            let kicked = false;
            const cleanup = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearInterval(timer);
                probe.removeEventListener("progress", tick);
                probe.removeEventListener("error", onError);
            };
            const onError = () => {
                cleanup();
                reject(new Error("新音源加载失败"));
            };
            /** 光靠 preload 拿不到数据（iOS 会等开播才取流）：静音跑起来催它下载 */
            const kick = () => {
                if (kicked || Date.now() - startedAt < SEAMLESS_KICK_DELAY) {
                    return;
                }
                kicked = true;
                probe.volume = 0;
                probe.play().catch((e) => {
                    console.warn("[trackPlayer] 预取播放器启动失败", e?.name ?? e);
                });
            };
            const tick = () => {
                if (settled) {
                    return;
                }
                if (isStale()) {
                    cleanup();
                    reject(new Error("切换已取消"));
                    return;
                }
                if (Date.now() - startedAt > SEAMLESS_TIMEOUT) {
                    cleanup();
                    reject(new Error("新音源缓冲超时"));
                    return;
                }
                if (probe.readyState < 1) {
                    kick();
                    return;
                }
                const live = livePosition();
                const bufferedEnd = bufferedEndAfter(probe, live);
                if (probe.readyState >= 3 && bufferedEnd >= live + SEAMLESS_LEAD) {
                    cleanup();
                    resolve();
                    return;
                }
                kick();
                // 缓冲没盖住播放头：把预取位置推到当前位置，让浏览器从这儿取流
                if (Date.now() - lastSeekAt > SEAMLESS_RESEEK_GAP) {
                    lastSeekAt = Date.now();
                    try {
                        probe.currentTime = live;
                    } catch {
                        // ignore
                    }
                }
            };
            probe.addEventListener("progress", tick);
            probe.addEventListener("error", onError);
            const timer = setInterval(tick, SEAMLESS_POLL);
            tick();
        });
    }

    /**
     * 交接：整个流程不 await，同步换掉主播放器，避免中途被换歌插队。
     * 新实例已经缓冲过播放头位置，所以听起来只是同一个位置接着播。
     */
    private commitQualitySwitch(
        probe: AudioBackend,
        resolved: {
            src: string;
            source?: IPlugin.IMediaSourceResult;
            quality: IMusic.IQualityKey | null;
        },
    ): IQualitySwitchResult {        const old = this.audio;
        const volume = old?.volume ?? getStoredVolume();
        const position = old?.currentTime ?? 0;
        const wasPlaying = !!old && !old.paused;

        this.clearStallWatch();
        this.clearPendingSeek();
        this.probeAudio = null;
        setAtom(qualitySwitchingAtom, null);
        if (old) {
            this.destroyAudioElement(old);
        }

        this.audio = probe;
        this.attachAudioListeners(probe);
        probe.volume = volume;
        probe.muted = false;
        probe.playbackRate = this._rate;
        probe.loop = this._repeatMode === "single";
        // 预取时被静音催起来过，这儿要么接着出声，要么就跟着旧的一起停住
        if (!wasPlaying) {
            if (!probe.paused) {
                this.internalPausePending = true;
            }
            probe.pause();
        }
        try {
            probe.currentTime = position;
        } catch {
            // ignore
        }
        this.pendingStartPosition = 0;
        this.stallNudges = 0;
        this.resolvedQuality = resolved.quality;
        this.resolvedSourceUrl = resolved.source?.url ?? null;
        setAtom(playingQualityAtom, resolved.quality);
        setAtom(progressAtom, {
            position,
            duration: probe.duration || this._currentMusic?.duration || 0,
        });

        if (wasPlaying) {
            probe.play().catch((e) => {
                console.warn("[trackPlayer] 切音质后起播失败", e?.name ?? e);
                if (this.audio === probe) {
                    setAtom(musicStateAtom, "paused");
                }
            });
        } else {
            setAtom(musicStateAtom, "paused");
        }
        return { status: "switched", quality: resolved.quality ?? getQuality() };
    }

    /**
     * 切换音质。播放中走无缝交接；暂停中只作废音源（下次播放用新音质）；
     * 本地文件与正在播本地下载文件的歌没有多音质，只记下偏好
     * （下载文件想换音质用「重新下载」更新本地文件）。
     */
    async applyQuality(quality: IMusic.IQualityKey): Promise<IQualitySwitchResult> {
        setQuality(quality);
        setAtom(qualityAtom, quality);
        // 预载的下一首是按旧音质解析的，作废后按新档重预
        this.abortNextTrackPreload();
        const music = this._currentMusic;
        const audio = this.audio;
        if (!music || music.localPath || this.playedFromLocalDownload || !audio?.src) {
            return { status: "queued" };
        }
        if (audio.paused) {
            this.pendingStartPosition = audio.currentTime || 0;
            this.detachAudio();
            return { status: "queued" };
        }
        // 原生后端是单实例 ExoPlayer：双播放器预取会顶掉正在播的歌。
        // 降级为「原位置重挂新音质」——大缓冲下交接间隙极短，可接受。
        if (audio instanceof NativeAudioElement) {
            const position = audio.currentTime || 0;
            await this.play(music, true, false, quality);
            this.pendingStartPosition = 0;
            return { status: "switched", quality };
        }
        return this.switchQualitySeamless(music, quality);
    }

    getProgress() {
        if (this.audio) {
            return {
                position: this.audio.currentTime,
                duration: this.audio.duration || 0,
            };
        }
        return { position: 0, duration: 0 };
    }
}

export const TrackPlayerSingleton = new TrackPlayer();

/**
 * 把「允许与其他应用同时播放」声明给播放后端：
 *  - 原生 ExoPlayer 后端：共播开 = 不参与音频焦点仲裁（抖音抢焦点不影响我们），
 *    共播关 = 正常仲裁（别人开播我们让位）；
 *  - 浏览器音频会话（Audio Session API，较新的 Chromium WebView 才支持）：
 *    ambient = 与其他应用混音共存；不支持的内核走 onAudioPause 里
 *    「被抢焦点自动续播」的兜底。
 */
export function applyCoPlaySessionType() {
    TrackPlayerSingleton.applyNativeFocusMode();
    try {
        const session = (navigator as any).audioSession;
        if (session) {
            session.type = getAllowCoPlay() ? "ambient" : "auto";
        }
    } catch {
        // 内核不认这个属性就算了，别影响播放
    }
}

/** ---------- hooks ---------- */
export function usePlayList() {
    return useAtomValue(playListAtom);
}
export function useCurrentMusic() {
    return useAtomValue(currentMusicAtom);
}
export function useMusicState() {
    return useAtomValue(musicStateAtom);
}
export function useRepeatMode() {
    return useAtomValue(repeatModeAtom);
}
export function useVolume() {
    return useAtomValue(volumeAtom);
}
export function useQuality() {
    return useAtomValue(qualityAtom);
}
export function usePlayingQuality() {
    return useAtomValue(playingQualityAtom);
}
/** 正在切换到哪个音质（null 表示没有切换在途） */
export function useQualitySwitching() {
    return useAtomValue(qualitySwitchingAtom);
}
export function setDefaultQuality(quality: IMusic.IQualityKey) {
    setQuality(quality);
    setAtom(qualityAtom, quality);
    // 在途预载按旧档解析的，作废后按新档重预
    TrackPlayerSingleton.abortNextTrackPreload();
}
/** 播放栏即时切换音质：后台缓冲目标音质，缓冲好了再无缝交接（设置页改默认值用 setDefaultQuality） */
export function applyQuality(quality: IMusic.IQualityKey) {
    return TrackPlayerSingleton.applyQuality(quality);
}
export function useProgress() {
    return useAtomValue(progressAtom);
}
export function useCurrentLyric() {
    return useAtomValue(currentLyricAtom);
}

export const currentLyricAtom = atom<ILyric.IParsedLrc>([]);

/**
 * 本地歌曲歌词解析器（由 localMusic 模块注册，避免循环依赖）：
 * 播放列表/历史里的本地条目可能早于匹配结果，播时向曲库现查一次
 */
let localLyricResolver: ((musicItem: IMusic.IMusicItem) => Promise<string>) | null = null;
export function setLocalLyricResolver(fn: (musicItem: IMusic.IMusicItem) => Promise<string>) {
    localLyricResolver = fn;
}

/** 加载当前歌曲歌词（插件接口名与桌面端一致：getLyric） */
export async function loadCurrentLyric(musicItem: IMusic.IMusicItem) {
    let lyricSource: ILyric.ILyricSource | null = musicItem.lyric ?? null;
    if (!lyricSource && musicItem.localPath) {
        // 本地歌曲：播放列表/历史里存的条目可能没有随匹配结果更新，向本地曲库现查歌词
        try {
            const raw = await localLyricResolver?.(musicItem);
            if (raw) {
                lyricSource = { rawLrc: raw };
            }
        } catch {
            // ignore
        }
    }
    if (!lyricSource && !musicItem.localPath) {
        const plugin = await getPluginByMedia(musicItem);
        if (plugin?.supportedMethods.includes("getLyric")) {
            try {
                lyricSource = await pluginCall(plugin.hash, "getLyric", musicItem);
            } catch {
                // ignore
            }
        }
    }
    let rawLrc = lyricSource?.rawLrc ?? "";
    if (!rawLrc && lyricSource?.lrc) {
        try {
            rawLrc = await (await fetch(lyricSource.lrc)).text();
        } catch {
            // ignore
        }
    }
    // translation 与 rawLrc 一样是纯文本（MusicFree 插件约定），原文走 lrc 链接时它也直接可用
    const translationLrc = lyricSource?.translation ?? "";
    store.set(currentLyricAtom, rawLrc ? parseLrc(rawLrc, translationLrc || undefined) : []);
}

function parseLrc(rawLrc: string, translationRaw?: string): ILyric.IParsedLrc {
    const result: ILyric.IParsedLrc = [];
    const lines = rawLrc.split("\n");
    const timeReg = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    lines.forEach((line) => {
        const text = line.replace(timeReg, "").trim();
        let match: RegExpExecArray | null;
        timeReg.lastIndex = 0;
        while ((match = timeReg.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fraction = match[3]
                ? parseInt(match[3], 10) / Math.pow(10, match[3].length)
                : 0;
            const time = minutes * 60 + seconds + fraction;
            result.push({ time, lrc: text, index: result.length });
        }
    });
    result.sort((a, b) => a.time - b.time);
    if (translationRaw?.trim()) {
        // 翻译与原文的两条时间轴大多逐行一致，但小数位精度可能不同：
        // 双指针按时间就近对齐（0.4s 内视为同一行），对不上就当作没有翻译
        const trans: { time: number; text: string }[] = [];
        translationRaw.split("\n").forEach((line) => {
            const text = line.replace(timeReg, "").trim();
            if (!text) {
                return;
            }
            let match: RegExpExecArray | null;
            timeReg.lastIndex = 0;
            while ((match = timeReg.exec(line)) !== null) {
                const minutes = parseInt(match[1], 10);
                const seconds = parseInt(match[2], 10);
                const fraction = match[3]
                    ? parseInt(match[3], 10) / Math.pow(10, match[3].length)
                    : 0;
                trans.push({ time: minutes * 60 + seconds + fraction, text });
            }
        });
        trans.sort((a, b) => a.time - b.time);
        let j = 0;
        for (const item of result) {
            while (j < trans.length - 1 && trans[j].time < item.time - 0.4) {
                j += 1;
            }
            if (j < trans.length && Math.abs(trans[j].time - item.time) <= 0.4) {
                item.translation = trans[j].text;
            }
        }
    }
    return result;
}
