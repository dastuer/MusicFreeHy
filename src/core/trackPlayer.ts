import { atom, getDefaultStore, useAtomValue } from "jotai";
import EventEmitter from "eventemitter3";
import { buildPlayableMediaUrl } from "./net";
import { getPluginByMedia, getPlugins, pluginCall } from "./ipc";
import { setMusicHistory } from "./musicHistory";
import { getQuality, setQuality, getConfig, getAllowCoPlay } from "./appConfig";
import { isNative, localFileUrl } from "./native";
import {
    lookupCachedSrc,
    notifyPageHidden,
    notifyPlaybackStarted,
    requestAudioCacheStore,
} from "./audioCache";
import {
    createAudioElement,
    destroyAudioBackend,
    IQueueWindowItem,
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

/** ---------- 队列窗口镜像（原生后端的后台连播根基） ---------- */

/**
 * 原生播放内核持有整条已解析队列：把接下来几首的音源在前台解析好推给
 * ExoPlayer（连同元数据），之后预缓冲、自动无缝续播、通知栏切歌全原生完成，
 * 熄屏后台不依赖 JS 存活。WebView 后端仍走下面的 probe 预载路径。
 */

/** 队列窗口推几首（与原生 QUEUE_WINDOW_MAX 一致） */
const QUEUE_WINDOW_SIZE = 4;

/** 结尾多少秒开始预加载下一首（仅 WebView 后端的 probe 路径使用） */
const NEXT_PRELOAD_AHEAD = 30;

/** 预加载失败后同曲多久内不重试（避免坏音源在结尾反复打插件） */
const NEXT_PRELOAD_RETRY_AFTER = 60000;

/** WebView 预缓冲元素视为就绪的最小缓冲秒数 */
const NEXT_PRELOAD_PROBE_LEAD = 3;

/** 预缓冲迟迟没有数据时静音催流的等待时间（iOS 会无视未开播元素的 preload） */
const NEXT_PRELOAD_KICK_DELAY = 3000;

/** 预缓冲就绪轮询间隔 */
const NEXT_PRELOAD_POLL = 1000;

/** 下一首的预加载记录（WebView 后端 probe 路径） */
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
}

/** 队列窗口镜像记录：mediaId → 已解析条目（transition 簿记按它对账） */
interface IMirroredTrack {
    musicItem: IMusic.IMusicItem;
    resolved: {
        src: string;
        source?: IPlugin.IMediaSourceResult;
        quality: IMusic.IQualityKey | null;
        localDownload?: true;
    };
    playSrc: string;
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

/**
 * 「预载曲目元数据预登记」机制已随旧架构移除：队列窗口条目自带元数据
 * （title/artist/album/artworkUri 随 pushQueueWindow 下发），通知栏由
 * Media3 直接从 MediaItem 渲染，不再需要 JS 侧另行登记。
 */

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
    /** 下一首的预加载记录（仅 WebView 后端 probe 路径；原生后端走队列窗口镜像） */
    private nextPreload: INextTrackPreload | null = null;
    /** 预加载会话序号：换歌 / 队列变动 / 换音质时作废在途预加载 */
    private nextPreloadSeq = 0;
    /** 预加载流程启动中（resolve 是异步的，防止 timeupdate 高频重入） */
    private preloadStarting = false;
    /** 最近一次预加载失败的曲键与时间：同曲一段时间内不再撞同一个坏音源 */
    private preloadFailedKey = "";
    private preloadFailedAt = 0;
    /** 队列窗口镜像记录：mediaId → 已解析条目（原生自动续播的簿记对账用） */
    private mirroredWindow: Map<string, IMirroredTrack> = new Map();
    /** 窗口镜像流程启动中（防 timeupdate / visibilitychange 重入） */
    private mirroring = false;
    /** 镜像会话序号：换歌 / 队列变动时作废在途镜像 */
    private mirrorSeq = 0;
    /** isLoading 的进入时间：回前台对账时识别「解析卡死」用 */
    private loadingSince = 0;
    /** 切后台兜底镜像的延后定时器（避开新应用冷启动窗口，见 visibilitychange 监听） */
    private hiddenMirrorTimer: ReturnType<typeof setTimeout> | null = null;

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
                if (backend instanceof NativeAudioElement) {
                    backend.mediaId = playListKey(this._currentMusic);
                }
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
                // 缓存下载静默 8s：切后台常伴随打开另一个应用（冷启动抢资源）
                notifyPageHidden();
                // 冻结前的兜底镜像：延后 5s 再做。切后台的瞬间往往正是用户打开
                // 另一个应用、对方冷启动抢 CPU/IO 的时刻——镜像（解析 + 下载）
                // 撞上去会挤占音频线程造成可听卡顿。真被冻结的话定时器不会执行，
                // 也无妨：主镜像在开播出声时已经就位，这里只是兜底。
                if (this.hiddenMirrorTimer) {
                    clearTimeout(this.hiddenMirrorTimer);
                }
                this.hiddenMirrorTimer = setTimeout(() => {
                    this.hiddenMirrorTimer = null;
                    this.maybeMirrorQueueWindow();
                }, 5000);
            } else {
                // 回前台：取消延后的镜像（马上会由对账流程补），并对齐状态
                if (this.hiddenMirrorTimer) {
                    clearTimeout(this.hiddenMirrorTimer);
                    this.hiddenMirrorTimer = null;
                }
                // 页面被冻结期间原生可能已自行续播，先把 JS 状态对齐播放器的现实
                void this.reconcileWithNative();
            }
            this.reconcileAfterForeground();
        });
        window.addEventListener("pagehide", persist);

        this.restoreSession();
        this.syncLoopFlag();
    }

    /**
     * 用原生播放器的真实状态校准 JS 侧。
     *
     * 熄屏后台时页面 JS 可能被冻结、甚至整个渲染进程被回收重建：期间曲目播完
     * 由 ExoPlayer 自动续播（预载生效），用户在通知栏按了暂停/切歌也只落在原生。
     * 回前台若不校准，界面会停在上一首、播放态与真实相反。
     * 以原生状态为事实来源补齐；JS 正忙（换歌解析中 / 重连中）时不动，避免打断在途操作。
     */
    async reconcileWithNative() {
        const audio = this.audio;
        if (!(audio instanceof NativeAudioElement) || this.reconnecting) {
            return;
        }
        // 解析卡死自愈：冻结期间 isLoading 标志被「冻住」（回前台后没有事件能清它），
        // 超过 45s 的 loading 一律视为卡死，先清标志再对账，否则对账会被 bail 掉
        // （表现为回前台界面永远停在加载/上一首）。
        if (this.isLoading && this.loadingSince > 0 && Date.now() - this.loadingSince > 45000) {
            console.warn("[trackPlayer] 回前台发现解析卡死（>45s），清理 loading 标志后对账");
            this.isLoading = false;
        }
        if (this.isLoading) {
            return;
        }
        const state = await audio.queryNativeState();
        if (!state) {
            return;
        }
        // 期间用户已手动换了歌 / 有新播放请求在途：以用户意图为准
        if (audio !== this.audio || this.isLoading) {
            return;
        }
        // 收养分支：JS 侧无源但原生有（页面重建等极端对账）——直接认领原生现状
        if (!this._currentMusic || (!audio.src && state.currentSrc)) {
            const nativeMusic = state.currentMediaId
                ? this._playList.find((it) => playListKey(it) === state.currentMediaId)
                : null;
            if (nativeMusic) {
                console.info(`[trackPlayer] 对账收养：原生正在播《${nativeMusic.title}》，对齐 JS 状态`);
                audio.adoptNativeState(state);
                this._currentMusic = nativeMusic;
                this.consumePendingNext(nativeMusic);
                this.pushHistory(nativeMusic);
                setAtom(currentMusicAtom, nativeMusic);
                this.emit(TrackPlayerEvents.CurrentMusicChanged, nativeMusic);
                setMusicHistory(nativeMusic);
                this.persistPlayList();
                setAtom(progressAtom, {
                    position: state.position,
                    duration: state.duration || nativeMusic.duration || 0,
                });
                setAtom(musicStateAtom, state.paused ? "paused" : "playing");
                await this.updateMediaSession(nativeMusic);
                this.maybeMirrorQueueWindow();
                return;
            }
        }
        const currentKey = this._currentMusic ? playListKey(this._currentMusic) : "";
        const trackChanged = !!state.currentMediaId && state.currentMediaId !== currentKey;
        if (trackChanged && !state.paused) {
            const nativeMusic = this._playList.find(
                (it) => playListKey(it) === state.currentMediaId,
            );
            if (nativeMusic) {
                console.info(
                    `[trackPlayer] 后台续播对账：播放器已在放《${nativeMusic.title}》，同步 JS 状态`,
                );
                // 播放器自行推进过了：镜像记录以原生现实为准（清掉旧记录）
                this.mirroredWindow.clear();
                this._currentMusic = nativeMusic;
                this.consumePendingNext(nativeMusic);
                this.pushHistory(nativeMusic);
                setAtom(currentMusicAtom, nativeMusic);
                this.emit(TrackPlayerEvents.CurrentMusicChanged, nativeMusic);
                setMusicHistory(nativeMusic);
                this.persistPlayList();
                void this.updateMediaSession(nativeMusic);
            }
        }
        // 播放态对齐：原生在出声就翻「播放中」，否则按暂停（进度交给 timeupdate 续报）
        if (!state.paused && store.get(musicStateAtom) !== "playing") {
            setAtom(musicStateAtom, "playing");
        } else if (state.paused && store.get(musicStateAtom) === "playing") {
            setAtom(musicStateAtom, "paused");
        }
        if (trackChanged) {
            setAtom(progressAtom, {
                position: state.position,
                duration: state.duration || this._currentMusic?.duration || 0,
            });
        }
        this.syncMediaSessionState();
        if (trackChanged || (state.hasNext && !this.mirroredWindow.size)) {
            // 对齐后窗口可能已经不对（推进过/被换过）：重镜像
            this.maybeMirrorQueueWindow();
        }
    }

    /**
     * WebView 静音保活音源已随旧架构移除：播放内核住在前台服务里，
     * 后台连播不再依赖 WebView JS 存活（队列窗口镜像 + 原生自动续播）。
     */

    /**
     * 回前台对账（后台自动停止的双保险）：冻结期间原生 ExoPlayer 的
     * ended / pause 事件可能到不了 JS。回前台时向原生后端问一次真实状态——
     * 已播完就补发 ended 走换歌链路（refreshState 内处理）；仍在播则
     * 补齐队列窗口；只是被暂停（Doze 断流自救失败等）且非用户主动暂停就补播。
     * WebView <audio> 后端不需要：元素在页面里，事件不会丢。
     */
    private async reconcileAfterForeground() {
        if (document.visibilityState !== "visible") {
            return;
        }
        const audio = this.audio;
        if (!(audio instanceof NativeAudioElement)) {
            return;
        }
        if (!this._currentMusic || this.reconnecting) {
            return;
        }
        // 解析卡死自愈：冻结期间 isLoading 被冻住的话先清掉（细节在 reconcileWithNative）
        if (this.isLoading && this.loadingSince > 0 && Date.now() - this.loadingSince > 45000) {
            this.isLoading = false;
        }
        if (this.isLoading) {
            return;
        }
        await audio.refreshState();
        const music = this._currentMusic;
        if (audio.paused && !audio.ended && !audio.error && !this.userPaused && !this.coPlayResumeTimer) {
            // 熄屏断流等场景里被系统静默暂停：非用户意图，补播回来
            this.resume();
        } else if (!audio.paused && music) {
            // 在播：确认队列窗口就位（冻结期间可能消耗了窗口却没补上）
            this.maybeMirrorQueueWindow();
        }
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
        // 结尾窗口预载只剩 WebView 后端还在用（原生后端的队列窗口在开播时已就位）
        if (!(this.audio instanceof NativeAudioElement)) {
            this.maybeStartNextTrackPreload(remaining);
        }
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
     * 把共播开关同步给原生后端的焦点策略：
     * 共播开（allowCoPlay=true）→ ExoPlayer 不参与音频焦点仲裁（抖音随便抢，
     * 我们不动）；共播关 → 正常仲裁（别人开播我们让位暂停）。
     * 原生侧默认即不入仲裁（focusEnabled=false），这里只在用户显式选独占时下发 true。
     * WebView 回退路径没有这个能力，靠 handleFocusLossSilently 的一次回抢兜底。
     */
    applyNativeFocusMode() {
        const audio = this.audio;
        if (audio instanceof NativeAudioElement) {
            audio.setAudioFocusMode(!getAllowCoPlay());
        }
    }

    /**
     * WebView 后端被抢了音频焦点（其他应用开播把播放暂停了）：静默回抢一次。
     *
     * 只回抢一次、不巡逻：抖音这类「声明 TRANSIENT 焦点再立即放弃」的高频抢焦点
     * 应用会与 play() 形成拉锯，反复暂停↔启动比让位更吵。抢不回来就保持暂停
     * （用户按播放继续）；原生后端不走这条路径——ExoPlayer 默认不入焦点仲裁，
     * 没有任何外部应用能让我们暂停。
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
        audio.play().catch(() => {
            // 被焦点占用：保持暂停，不进入重试拉锯
        });
    }

    /** 巡逻机制已随拉锯一并移除：只清计时器（保险，避免遗留句柄） */
    private stopCoPlayResumeWatch() {
        if (this.coPlayResumeTimer) {
            clearTimeout(this.coPlayResumeTimer);
            this.coPlayResumeTimer = null;
        }
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
        // 真正出声：重置缓存下载的开播静默窗（开播初期缓冲水位未建立，
        // 取流优先于后台整首下载，见 audioCache.notifyPlaybackStarted）
        notifyPlaybackStarted();
        // 换歌路上 detachAudio 的内部暂停事件会把 userPaused 置回 true（与用户
        // 主动暂停共用同一条 pause 通道），真正出声即视为用户要播，共播回抢恢复
        this.userPaused = false;
        // 开播完成：把队列窗口推给原生播放器（后台连播的根基——窗口必须
        // 在前台期就位，冻结后 JS 不可依赖）
        if (this.audio instanceof NativeAudioElement) {
            this.maybeMirrorQueueWindow();
        }
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
        this.loadingSince = Date.now();
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

    /** 结尾窗口触发预加载：remaining 已在 onProgress 算好（Infinity = 时长未知）。
     *  仅 WebView 后端走这条路径（原生后端的窗口镜像在开播完成时触发） */
    private maybeStartNextTrackPreload(remaining: number) {
        if (this.nextPreload || this.preloadStarting || this.isLoading) {
            return;
        }
        if (this._repeatMode === "single" || !this._currentMusic || !this.audio?.src) {
            return;
        }
        if (this.audio instanceof NativeAudioElement) {
            return;
        }
        if (remaining > NEXT_PRELOAD_AHEAD || remaining <= 0.3) {
            return;
        }
        this.preloadStarting = true;
        void this.startNextTrackPreload();
    }
    /** 预加载流程（仅 WebView 后端）：解析下一首音源 → 判缓存 → 开预缓冲元素 */
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
            if (!audio || audio instanceof NativeAudioElement) {
                this.nextPreload = null;
                return;
            }
            const probe: AudioBackend = new Audio();
            probe.preload = "auto";
            preload.probe = probe;
            probe.src = playSrc;
            this.monitorPreloadProbe(probe, seq, preload);
        } finally {
            this.preloadStarting = false;
        }
    }

    /**
     * 按换歌语义连算「接下来的 n 首」（窗口镜像用）：
     * 待播（下一首播放）优先，其次按队列顺序推进，随机模式按「模拟消费」走
     * （每次从剩余队列随机取一首，与 getNextIndex 的 queue 语义一致）。
     * 单曲循环交给 audio.loop，不进窗口；repeat off 的队尾之后没有下一首。
     */
    private async computeUpcoming(n: number): Promise<IMusic.IMusicItem[]> {
        const result: IMusic.IMusicItem[] = [];
        const consumed = new Set<string>();
        // 队列与待播登记的本地副本：模拟推进不影响真实状态
        let queue = this._playList;
        const pending = [...this._pendingNext];
        const repeatQueue = this._repeatMode === "queue";
        const curIndex = this.getMusicIndexInPlayList(this._currentMusic);
        let cursor = curIndex;
        while (result.length < n) {
            let nextItem: IMusic.IMusicItem | null = null;
            // 1) 待播优先（按登记顺序，第一个还在队列里的）
            while (pending.length) {
                const key = pending.shift()!;
                const idx = queue.findIndex((it) => playListKey(it) === key);
                if (idx >= 0 && !consumed.has(key)) {
                    nextItem = queue[idx];
                    cursor = idx;
                    break;
                }
            }
            // 2) 队列顺序
            if (!nextItem && queue.length) {
                if (repeatQueue) {
                    // 随机模式：与 getNextIndex 一致，从非当前里随机（单首队列原地循环）
                    if (queue.length === 1) {
                        nextItem = repeatQueue ? queue[0] : null;
                    } else {
                        let pick = cursor;
                        while (pick === cursor) {
                            pick = Math.floor(Math.random() * queue.length);
                        }
                        nextItem = queue[pick];
                        cursor = pick;
                    }
                } else {
                    const nextIdx = cursor < 0 ? 0 : cursor + 1;
                    if (nextIdx < queue.length) {
                        nextItem = queue[nextIdx];
                        cursor = nextIdx;
                    } else if (queue.length === 1 && curIndex === 0) {
                        // 单首队列 + 非 repeat off 的兜底（onEnded 会循环它）
                        nextItem = this._repeatMode !== "off" ? queue[0] : null;
                        cursor = 0;
                    }
                }
            }
            if (!nextItem) {
                break;
            }
            const key = playListKey(nextItem);
            if (consumed.has(key)) {
                break; // 绕回来了（单首随机队列）：窗口封口
            }
            consumed.add(key);
            result.push(nextItem);
        }
        return result;
    }

    /**
     * 队列窗口镜像：解析接下来几首 → 推给原生播放器（连同元数据）。
     * 成功的条目记进 mirroredWindow，原生自动续播时 onItemTransition 按
     * mediaId 在这里对账。解析失败的单曲跳过（不阻塞后面的歌）。
     */
    private async mirrorUpcomingWindow() {
        const audio = this.audio;
        if (
            this.mirroring ||
            !(audio instanceof NativeAudioElement) ||
            this._repeatMode === "single" ||
            !this._currentMusic ||
            !this._playList.length
        ) {
            return;
        }
        this.mirroring = true;
        const seq = ++this.mirrorSeq;
        try {
            const upcoming = await this.computeUpcoming(QUEUE_WINDOW_SIZE);
            if (seq !== this.mirrorSeq) {
                return;
            }
            if (!upcoming.length) {
                // 没有下一首（队尾 repeat off 等）：清掉原生窗口
                this.mirroredWindow.clear();
                await audio.pushQueueWindow([]);
                return;
            }
            const items: IQueueWindowItem[] = [];
            const mirrored: Map<string, IMirroredTrack> = new Map();
            for (const musicItem of upcoming) {
                const key = playListKey(musicItem);
                // 冷却期内的坏音源不再撞（与 WebView probe 路径同规则）
                if (
                    this.preloadFailedKey === key &&
                    Date.now() - this.preloadFailedAt < NEXT_PRELOAD_RETRY_AFTER
                ) {
                    continue;
                }
                try {
                    const resolved = await this.resolveMediaUrl(musicItem);
                    if (seq !== this.mirrorSeq) {
                        return;
                    }
                    if (!resolved.ok) {
                        this.preloadFailedKey = key;
                        this.preloadFailedAt = Date.now();
                        console.warn(`[trackPlayer] 窗口镜像解析失败 ${musicItem.title}：${resolved.reason}`);
                        continue;
                    }
                    let playSrc = resolved.src;
                    if (!musicItem.localPath && !resolved.localDownload) {
                        // 与 play() 同规则：命中缓存播本地；未命中顺路后台缓存
                        const cached = await lookupCachedSrc(musicItem, resolved.quality);
                        if (seq !== this.mirrorSeq) {
                            return;
                        }
                        if (cached) {
                            playSrc = cached;
                        } else {
                            requestAudioCacheStore(musicItem, resolved.quality, resolved.source);
                        }
                    }
                    items.push({
                        mediaId: key,
                        src: playSrc,
                        title: musicItem.title ?? "",
                        artist: musicItem.artist ?? "",
                        album: musicItem.album ?? "",
                        artworkUri: typeof musicItem.artwork === "string" ? musicItem.artwork : "",
                    });
                    mirrored.set(key, {
                        musicItem,
                        resolved: {
                            src: resolved.src,
                            source: resolved.source,
                            quality: resolved.quality,
                            localDownload: resolved.localDownload,
                        },
                        playSrc,
                    });
                } catch (e: any) {
                    console.warn(`[trackPlayer] 窗口镜像异常 ${musicItem.title}`, e?.message ?? e);
                }
            }
            if (seq !== this.mirrorSeq) {
                return;
            }
            this.mirroredWindow = mirrored;
            try {
                await audio.pushQueueWindow(items);
            } catch (e: any) {
                console.warn("[trackPlayer] 队列窗口推送失败", e?.message ?? e);
                this.mirroredWindow.clear();
                return;
            }
            console.info(`[trackPlayer] 队列窗口就位：${items.length} 首`);
        } finally {
            this.mirroring = false;
        }
    }

    /** 窗口镜像触发守卫：在播、原生后端、没有在途镜像时才补 */
    private maybeMirrorQueueWindow() {
        const audio = this.audio;
        if (
            !audio ||
            !(audio instanceof NativeAudioElement) ||
            !audio.src ||
            this.isLoading ||
            this.reconnecting ||
            this.mirroring
        ) {
            return;
        }
        void this.mirrorUpcomingWindow();
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
     * 作废在途预加载与窗口镜像：队列变动 / 换歌 / 换音质 / 改重复模式都会走到这里。
     * WebView 后端要销毁预缓冲元素；原生后端要撤下已推送的窗口条目，否则
     * ExoPlayer 会在当前曲播完自动续播一首 JS 侧已经不认的歌。
     */
    abortNextTrackPreload() {
        this.nextPreloadSeq += 1;
        this.mirrorSeq += 1;
        const preload = this.nextPreload;
        this.nextPreload = null;
        this.mirroredWindow.clear();
        if (preload?.probe) {
            this.destroyAudioElement(preload.probe);
        }
        if (this.audio instanceof NativeAudioElement) {
            // 清空窗口：推送一个空列表（原生侧替换当前曲之后的全部条目）
            this.audio.pushQueueWindow([]).catch(() => {});
        }
    }

    /**
     * WebView 后端的歌播完了：预缓冲元素若可用就交接，否则走原有链路。
     * 复核一遍取歌语义（队列可能刚变过），对不上就作废预加载。
     */
    private async tryCommitPreloadedNext(): Promise<boolean> {
        const preload = this.nextPreload;
        if (!preload?.playSrc || !preload.probe) {
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
     * 原生播放器自动续播了窗口里的下一首（itemtransition，mediaId 命中镜像记录）。
     * 声音已经接上了，这里只做换歌簿记，让 JS 侧状态跟上播放器的现实。
     */
    private onItemTransition = async (ev: any) => {
        const mediaId = String(ev?.mediaId ?? "");
        if (!mediaId) {
            return; // loadTrack 引起的过渡（无 mediaId），不是自动续播
        }
        const mirrored = this.mirroredWindow.get(mediaId);
        if (!mirrored) {
            // 兜底：镜像记录已不在（页面冻结期间推进过多首 / 队列被换过）。
            // 以原生播放器的现实为准对齐状态——避免按过期记录把状态往回改。
            await this.reconcileWithNative();
            return;
        }
        // 页面冻结期间可能已经播过不止一首：与原生现实对不上时走对账
        const audio = this.audio;
        if (audio instanceof NativeAudioElement) {
            const state = await audio.queryNativeState();
            if (state?.currentMediaId && state.currentMediaId !== mediaId) {
                await this.reconcileWithNative();
                return;
            }
        }
        this.mirroredWindow.delete(mediaId);
        await this.commitPreloadedNext(mirrored);
        // 窗口消耗掉一首：立即补镜像（前台时窗口永远满着）
        this.maybeMirrorQueueWindow();
    };

    /**
     * 交接下一首：簿记与 play() 的换歌分支一致（队列 / 历史 / atom /
     * 媒体会话），音频侧两条后端不同——原生已在播新曲，只翻状态；WebView
     * 把预缓冲元素扶正为主播放器再开播。
     */
    private async commitPreloadedNext(
        preload:
            | INextTrackPreload
            | IMirroredTrack,
    ) {
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

        const audio = this.audio;
        if (audio instanceof NativeAudioElement) {
            // 原生后端：ExoPlayer 已经在出声，簿记完成即无缝换歌成功。
            // 过渡不产生 playing 事件，重试计数器在这里手工清零（WebView 路径由
            // onAudioPlaying 统一清）；顺带重置缓存下载静默窗
            notifyPlaybackStarted();
            this.isLoading = false;
            this.autoSkipCount = 0;
            this.qualityRetryCount = 0;
            this.reconnectCount = 0;
            setAtom(musicStateAtom, "playing");
            return;
        }

        // WebView 后端：预缓冲元素接棒。数据已缓冲好，交接只是换实例 + 起播
        // （原生路径的镜像记录没有 probe，走到这必是 WebView probe 预载）
        if (!("probe" in preload) || !preload.probe) {
            return;
        }
        const probe = preload.probe;
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

        /** 本次起播用的播放器实例（catch 里判断它是否已被换掉） */
        let playAudio: AudioBackend | null = null;
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
            playAudio = audio;
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
            // 原生后端：把曲目标识写进 ExoPlayer 条目——页面被系统冻结期间播放器
            // 自行换歌后，JS 回前台靠它核对「现在放的到底是队列里的哪一首」。
            // 必须在赋 src 之前：src 的 setter 会把 mediaId 一并发给原生
            if (audio instanceof NativeAudioElement) {
                audio.mediaId = playListKey(target);
                // 元数据随行：当前曲的通知栏/锁屏显示
                audio.setTrackMeta({
                    title: target.title ?? "",
                    artist: target.artist ?? "",
                    album: target.album ?? "",
                    artworkUri:
                        typeof target.artwork === "string" && target.artwork.length <= 64 * 1024
                            ? target.artwork
                            : "",
                });
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
            // 原生后端的 play() promise 在 pause/ended 事件下也会以成功落定
            // （换歌的滞后 pause、起播瞬间用户暂停等），是否真的在播以 paused 为准，
            // 别把被暂停的起播翻成假「播放中」。
            if (this.pendingPlayId === playId && !audio.paused) {
                setAtom(musicStateAtom, "playing");
            }
        } catch (e: any) {
            // 播放器实例已被换掉（后端接管 / 预载交接 / 切音质）：旧实例上滞后的
            // 失败与新歌无关，不进失败链。playAudio 为空说明还没走到取实例那步，
            // 失败来自解析阶段，照常处理。
            if (
                this.pendingPlayId !== playId ||
                (playAudio && this.audio !== playAudio)
            ) {
                return;
            }
            // 起播缓冲期间用户主动暂停（WebView 后端的 play() 会以 AbortError 拒绝）：
            // 是用户意图不是播放失败，暂停态已由 pause 事件维护
            if (e?.name === "AbortError" && this.userPaused) {
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
        // 原生后端优先走队列直切：窗口里的歌不用重新解析，无缝且极快。
        // 切过去后簿记由 itemtransition 事件统一做（onItemTransition → 对账）。
        const audio = this.audio;
        if (audio instanceof NativeAudioElement && audio.src && !this.isLoading) {
            const mediaId = await audio.skipNative("next");
            if (mediaId) {
                return;
            }
        }
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
        // 原生队列直切优先（服务保留最近 2 首已播条目）
        const audio = this.audio;
        if (audio instanceof NativeAudioElement && audio.src && !this.isLoading) {
            const mediaId = await audio.skipNative("previous");
            if (mediaId) {
                return;
            }
        }
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
