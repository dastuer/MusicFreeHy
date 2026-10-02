import { atom, getDefaultStore, useAtomValue } from "jotai";
import EventEmitter from "eventemitter3";
import { buildPlayableMediaUrl } from "./net";
import { getPluginByMedia, getPlugins, pluginCall } from "./ipc";
import { setMusicHistory } from "./musicHistory";
import { getQuality, setQuality, getConfig } from "./appConfig";
import { localFileUrl } from "./native";
import { lookupCachedSrc, requestAudioCacheStore } from "./audioCache";

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

/** MediaError 转成人话（见 HTMLMediaElement.error） */
function describeMediaError(err?: MediaError | null) {
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
function bufferedEndAfter(audio: HTMLAudioElement, position: number): number {
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

class TrackPlayer extends EventEmitter {
    private audio: HTMLAudioElement | null = null;
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
    private pendingSeekListener: (() => void) | null = null;
    private pendingStartPosition = 0;
    private resolvedQuality: IMusic.IQualityKey | null = null;
    private resolvedSourceUrl: string | null = null;
    private qualityRetrying = false;
    private qualityRetryCount = 0;
    /** 无缝切音质时后台缓冲用的临时播放器，交接后变成主播放器 */
    private probeAudio: HTMLAudioElement | null = null;
    /** 在途切换的序号：换歌 / 再次切换时用它作废旧预取 */
    private qualitySwitchSeq = 0;
    /** 当前播放是否来自「已下载的本地文件」：失败兜底与音质切换按 localPath 同规则处理 */
    private playedFromLocalDownload = false;
    /** 本地下载文件播放失败过的歌（本次会话内直接走线上，不再反复撞同一个坏文件） */
    private localDownloadBypass = new Set<string>();

    setup() {
        if (this.audio) {
            return;
        }
        const audio = new Audio();
        audio.preload = "auto";
        audio.volume = getStoredVolume();
        this.attachAudioListeners(audio);
        this.audio = audio;

        // Pad 版：切后台 / 关页面前把「听到哪儿」写进 localStorage（桌面端是退出握手写 session.json）
        const persist = () => this.persistProgress();
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
                persist();
            }
        });
        window.addEventListener("pagehide", persist);

        this.restoreSession();
    }

    private attachAudioListeners(audio: HTMLAudioElement) {
        audio.addEventListener("ended", this.onEnded);
        audio.addEventListener("timeupdate", this.onProgress);
        audio.addEventListener("loadedmetadata", this.onProgress);
        audio.addEventListener("pause", this.onAudioPause);
        audio.addEventListener("play", this.onAudioPlay);
        audio.addEventListener("playing", this.onAudioPlaying);
        audio.addEventListener("error", this.onAudioError);
        audio.addEventListener("waiting", this.onAudioWaiting);
        audio.addEventListener("stalled", this.onAudioStall);
    }

    private detachAudioListeners(audio: HTMLAudioElement) {
        audio.removeEventListener("ended", this.onEnded);
        audio.removeEventListener("timeupdate", this.onProgress);
        audio.removeEventListener("loadedmetadata", this.onProgress);
        audio.removeEventListener("pause", this.onAudioPause);
        audio.removeEventListener("play", this.onAudioPlay);
        audio.removeEventListener("playing", this.onAudioPlaying);
        audio.removeEventListener("error", this.onAudioError);
        audio.removeEventListener("waiting", this.onAudioWaiting);
        audio.removeEventListener("stalled", this.onAudioStall);
    }

    /** 彻底弃用一个播放器实例：摘掉监听，免得它的 pause/error 事件回头改状态 */
    private destroyAudioElement(audio: HTMLAudioElement) {
        this.detachAudioListeners(audio);
        audio.pause();
        audio.removeAttribute("src");
        try {
            audio.load();
        } catch {
            // ignore
        }
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
        this.clearStallWatch();
        if (this.isLoading) {
            return;
        }
        if (this._currentMusic) {
            setAtom(musicStateAtom, "paused");
        }
        this.syncMediaSessionState();
    };

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
        setAtom(musicStateAtom, "playing");
        this.syncMediaSessionState();
    };

    private onAudioError = async () => {
        const err = this.audio?.error;
        console.warn(`[trackPlayer] media error code=${err?.code} message=${err?.message}`);
        if (!this._currentMusic || !this.audio?.src) {
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
    private applyStartPosition(audio: HTMLAudioElement, position: number) {
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

    /** 清空播放队列，正在播的这首继续播 */
    clearPlayList() {
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
        this.audio?.pause();
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

    toggleRepeatMode() {
        const order: MusicRepeatMode[] = ["off", "queue", "single"];
        const next = order[(order.indexOf(this._repeatMode) + 1) % order.length];
        this._repeatMode = next;
        setAtom(repeatModeAtom, next);
        localStorage.setItem("repeatMode", next);
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
        let probe: HTMLAudioElement | null = null;
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
        probe: HTMLAudioElement,
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
        probe: HTMLAudioElement,
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
        // 预取时被静音催起来过，这儿要么接着出声，要么就跟着旧的一起停住
        if (!wasPlaying) {
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
    store.set(currentLyricAtom, rawLrc ? parseLrc(rawLrc) : []);
}

function parseLrc(rawLrc: string): ILyric.IParsedLrc {
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
    return result;
}
