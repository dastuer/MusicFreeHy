/**
 * 原生音频后端（Android）：把 MediaPlaybackService 里的 ExoPlayer 伪装成
 * HTMLAudioElement。
 *
 * 播放内核（ExoPlayer + MediaSession）住在前台服务里、持有整条已解析队列：
 * 前台 JS 把接下来几首经 pushQueueWindow 推进去后，预缓冲/自动续播/通知栏
 * 切歌全部原生完成，后台连播不依赖 JS 存活——这是后台播放根治的核心。
 * JS 侧只做三件事：装载当前曲、镜像队列窗口、做换歌簿记（itemtransition）。
 *
 * 对 trackPlayer 呈现与 <audio> 相同的接口（属性 + 事件 + play() 返回
 * promise），播放主流程不用感知后端差异。插件缺失时 createAudioElement()
 * 回退 WebView <audio>（浏览器 dev 模式）。
 */

import { addNativeListener, callNativeMethod, isNative } from "./native";

const PLUGIN = "PlaybackBridge";

/** 是否已确认原生音频后端可用（缓存探测结果） */
let backendReady: boolean | null = null;

/** 队列窗口条目：推给原生预载的下一批歌（mediaId = platform-id） */
export interface IQueueWindowItem {
    mediaId: string;
    src: string;
    title: string;
    artist: string;
    album: string;
    artworkUri: string;
}

/** 探测原生音频插件是否可用；浏览器 / 老包回退 WebView <audio> */
export async function probeNativeAudio(): Promise<boolean> {
    if (!isNative()) {
        return false;
    }
    if (backendReady !== null) {
        return backendReady;
    }
    try {
        const platform = (window as any).Capacitor?.getPlatform?.();
        if (platform !== "android") {
            backendReady = false;
            return false;
        }
        const res = await callNativeMethod(PLUGIN, "isAvailable");
        backendReady = !!res?.available;
    } catch {
        backendReady = false;
    }
    return backendReady;
}

/** 当前是否在用原生后端（同步查询，setup 阶段已定） */
export function isNativeAudioBackend(): boolean {
    return backendReady === true;
}

type ListenerEntry = { fn: (ev: any) => void; once: boolean };

/** 原生播放器的真实状态快照（trackPlayer 回前台对账用） */
export interface INativeAudioState {
    /** 播放器当前曲目的 mediaId（platform-id；空串表示未知） */
    currentMediaId: string;
    /** 当前曲目的 JS 侧地址（收养对账用；空串未知） */
    currentSrc: string;
    position: number;
    duration: number;
    paused: boolean;
    ended: boolean;
    /** 原生队列里「当前曲之后」还有没有预载条目 */
    hasNext: boolean;
}

/** MediaError 形状（对齐 HTMLMediaElement.error） */
class NativeMediaError {
    readonly code: number;
    readonly message: string;
    constructor(code: number, message: string) {
        this.code = code;
        this.message = message;
    }
}

/**
 * HTMLAudioElement 的原生后端代理。
 * 属性读写直接映射到原生 getState / 控制方法；事件由原生 audioEvent 转发。
 * readyState / buffered 由 timeupdate 上报的 bufferedMs 推算。
 */
export class NativeAudioElement {
    private listeners = new Map<string, Set<ListenerEntry>>();
    private lastReport = {
        positionMs: 0,
        bufferedMs: 0,
        durationMs: NaN as number,
        paused: true,
        rate: 1,
        volume: 1,
    };
    private playRejecters = new Set<(e: any) => void>();
    private playResolvers = new Set<() => void>();
    private detach: (() => void) | null = null;
    /**
     * play()/pause() 的即时翻态：原生回报有桥接延迟，调用方
     * （detachAudio 的内部暂停标记、onProgress 的状态判断）依赖同步语义。
     */
    private _pausedOptimistic: boolean | null = null;

    // ---------- 与 <audio> 同形的公开属性 ----------

    /** 有源且已初始化过原生播放器（无源时 src=""） */
    private _src = "";
    private _autoplay = false;
    private _loop = false;
    private _muted = false;
    private _volume = 1;
    private _rate = 1;
    private _pendingSeekMs: number | null = null;
    private _hasSource = false;
    private _error: NativeMediaError | null = null;
    private _ended = false;
    private _preload = "auto";
    /**
     * 当前曲目的 mediaId（platform-id）。装载时写进 ExoPlayer 的 MediaItem，
     * 页面被冻结期间原生自动续播后，回前台靠 mediaId 与 JS 队列对齐。
     */
    private _mediaId = "";
    /** 最近一次推给原生的窗口条目（mediaId → item）：transition 簿记对账用 */
    private windowItems: Map<string, IQueueWindowItem> = new Map();

    constructor(options?: { autoplay?: boolean }) {
        this._autoplay = !!options?.autoplay;
        this.detach = addNativeListener(PLUGIN, "audioEvent", (data: any) => {
            this.onNativeEvent(data);
        });
        // 前台服务是播放内核的宿主：没起来时所有桥接调用都会失败
        callNativeMethod(PLUGIN, "ensureService").catch(() => {});
    }

    // ---------- 属性（getter/setter 映射原生） ----------

    get src(): string {
        return this._src;
    }

    set src(value: string) {
        this._error = null;
        this._ended = false;
        this._src = value ?? "";
        this._hasSource = !!this._src;
        this.windowItems.clear();
        if (!this._src) {
            callNativeMethod(PLUGIN, "stop").catch(() => {});
            return;
        }
        const startMs = this._pendingSeekMs && this._pendingSeekMs > 0 ? this._pendingSeekMs : undefined;
        this._pendingSeekMs = null;
        // 焦点模式随装载同步：服务被系统杀掉重建后原生侧回到默认（不入仲裁），
        // JS 侧设置页改过独占模式的话，这里把用户选择重新声明一遍
        callNativeMethod(PLUGIN, "setAudioFocusMode", { focusEnabled: this._focusRequested })
            .catch(() => {});
        // 装载元数据随行：通知栏/锁屏直接显示（不再走 metadata 上报通道）
        callNativeMethod(PLUGIN, "loadTrack", {
            src: this._src,
            mediaId: this._mediaId,
            startMs,
            autoplay: this._autoplay,
            title: this._meta?.title ?? "",
            artist: this._meta?.artist ?? "",
            album: this._meta?.album ?? "",
            artworkUri: this._meta?.artworkUri ?? "",
        }).catch((e: any) => {
            this._error = new NativeMediaError(4, String(e?.message ?? e));
            this.fire("error");
        });
    }

    get paused(): boolean {
        return this._pausedOptimistic ?? this.lastReport.paused;
    }

    get ended(): boolean {
        return this._ended;
    }

    get duration(): number {
        const ms = this.lastReport.durationMs;
        return Number.isFinite(ms) && ms > 0 ? ms / 1000 : NaN;
    }

    get currentTime(): number {
        return (this._pendingSeekMs ?? this.lastReport.positionMs) / 1000;
    }

    set currentTime(seconds: number) {
        const ms = Math.max(0, Math.round(seconds * 1000));
        this._pendingSeekMs = ms;
        callNativeMethod(PLUGIN, "seekTo", { positionMs: ms }).catch(() => {});
    }

    get playbackRate(): number {
        return this._rate;
    }

    set playbackRate(rate: number) {
        this._rate = rate || 1;
        callNativeMethod(PLUGIN, "setRate", { rate: this._rate }).catch(() => {});
    }

    get volume(): number {
        return this._volume;
    }

    set volume(v: number) {
        this._volume = Math.min(Math.max(v, 0), 1);
        this.applyVolume();
        this.fire("volumechange");
    }

    get muted(): boolean {
        return this._muted;
    }

    set muted(m: boolean) {
        this._muted = !!m;
        this.applyVolume();
        this.fire("volumechange");
    }

    get loop(): boolean {
        return this._loop;
    }

    set loop(l: boolean) {
        this._loop = !!l;
        callNativeMethod(PLUGIN, "setRepeatMode", { repeatOne: this._loop }).catch(() => {});
    }

    get autoplay(): boolean {
        return this._autoplay;
    }

    set autoplay(a: boolean) {
        this._autoplay = !!a;
    }

    /** 最近一次设置给原生的焦点模式（装载时随行重发，服务重建后恢复用户选择） */
    private _focusRequested = false;

    /** 装载当前曲时随行的元数据（通知栏/锁屏显示；由 trackPlayer 在赋 src 前设置） */
    private _meta: { title: string; artist: string; album: string; artworkUri: string } | null =
        null;

    /** 当前曲目的展示元数据：随 loadTrack 下发，通知栏由 Media3 直接渲染 */
    setTrackMeta(meta: {
        title: string;
        artist: string;
        album: string;
        artworkUri: string;
    }) {
        this._meta = meta;
    }

    /**
     * 当前曲目的标识（platform-id）。与 src 配合：src 决定播什么，
     * mediaId 让原生侧认得出「现在播的是队列里的哪一首」，页面冻结期间
     * 原生自动续播后 JS 才能对上号。
     */
    get mediaId(): string {
        return this._mediaId;
    }

    set mediaId(id: string) {
        this._mediaId = id ?? "";
    }

    get preload(): string {
        return this._preload;
    }

    set preload(p: string) {
        this._preload = p;
    }

    get error(): NativeMediaError | null {
        return this._error;
    }

    /** HAVE_NOTHING=0 … HAVE_ENOUGH_DATA=4；由原生状态映射 */
    get readyState(): number {
        if (!this._hasSource) {
            return 0;
        }
        if (this.lastReport.paused && !this._error && !Number.isFinite(this.duration)) {
            // 无时长信息：大概率还没准备好
            return 1;
        }
        return 4;
    }

    /** 模拟 buffered TimeRanges：单一区间 [0, bufferedMs]（ExoPlayer 对外就这个粒度） */
    get buffered(): { length: number; start: (i: number) => number; end: (i: number) => number } {
        const endSec = this.lastReport.bufferedMs / 1000;
        const self = this;
        return {
            get length() {
                return endSec > 0 ? 1 : 0;
            },
            start: (i: number) => (i === 0 ? 0 : NaN),
            end: (i: number) => (i === 0 ? endSec : NaN),
        };
    }

    // ---------- 方法 ----------

    async play(): Promise<void> {
        this._ended = false;
        this._pausedOptimistic = false;
        return new Promise<void>((resolve, reject) => {
            this.playResolvers.add(resolve);
            this.playRejecters.add(reject);
            callNativeMethod(PLUGIN, "play").catch((e: any) => {
                this.playResolvers.delete(resolve);
                this.playRejecters.delete(reject);
                this._pausedOptimistic = null;
                reject(e);
            });
        });
    }

    pause(): void {
        this._pausedOptimistic = true;
        callNativeMethod(PLUGIN, "pause").catch(() => {});
    }

    load(): void {
        // src 设置时已 prepare，这里对齐「重置到无源」的用法（removeAttribute 后）
        if (!this._src) {
            callNativeMethod(PLUGIN, "stop").catch(() => {});
        }
    }

    /** 对齐 audio.removeAttribute("src") */
    removeAttribute(name: string): void {
        if (name === "src") {
            this._src = "";
            this._hasSource = false;
            this._pendingSeekMs = null;
            this._error = null;
            this._ended = false;
            this.windowItems.clear();
            callNativeMethod(PLUGIN, "stop").catch(() => {});
        }
    }

    setAttribute(name: string, value: any): void {
        if (name === "src") {
            this.src = String(value);
        } else if (name === "loop") {
            this.loop = value !== "false" && !!value;
        }
    }

    addEventListener(
        type: string,
        listener: (ev: any) => void,
        options?: { once?: boolean },
    ): void {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add({ fn: listener, once: !!options?.once });
    }

    removeEventListener(type: string, listener: (ev: any) => void): void {
        const set = this.listeners.get(type);
        if (!set) {
            return;
        }
        for (const entry of [...set]) {
            if (entry.fn === listener) {
                set.delete(entry);
            }
        }
    }

    /** 彻底弃用（对应 destroyAudioElement）：停播放器并解绑原生事件 */
    destroy(): void {
        this.pause();
        this.removeAttribute("src");
        this.detach?.();
        this.detach = null;
        this.listeners.clear();
        this.playRejecters.forEach((r) =>
            r(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
        this.playRejecters.clear();
        this.playResolvers.clear();
    }

    // ---------- 原生播放内核专属 ----------

    /**
     * 队列窗口镜像：把接下来几首的已解析音源（连同元数据）推给原生，
     * 替换「当前曲之后」的预载位。之后当前曲播完由 ExoPlayer 自动无缝续播，
     * 不经过 JS——后台连播的根基。
     */
    async pushQueueWindow(items: IQueueWindowItem[]): Promise<void> {
        this.windowItems = new Map(items.map((it) => [it.mediaId, it]));
        await callNativeMethod(PLUGIN, "pushQueueWindow", { items });
    }

    /** 原生队列直切（通知栏同款通路）：切到返回 mediaId，切不了返回 null */
    async skipNative(direction: "next" | "previous"): Promise<string | null> {
        try {
            const res = await callNativeMethod(PLUGIN, "skip", { direction });
            const mediaId = String(res?.mediaId ?? "");
            return mediaId || null;
        } catch {
            return null;
        }
    }

    /** 共播开关切换：true=参与系统焦点仲裁，false=完全不响应焦点 */
    setAudioFocusMode(focusEnabled: boolean) {
        this._focusRequested = focusEnabled;
        callNativeMethod(PLUGIN, "setAudioFocusMode", { focusEnabled }).catch(() => {});
    }

    /**
     * 回前台对账：从原生拉一次真实播放状态，更新本地快照。
     * ExoPlayer 已把当前曲播完（STATE_ENDED）就补发 ended 走换歌链路。
     */
    async refreshState(): Promise<void> {
        try {
            const res = await callNativeMethod(PLUGIN, "getState");
            if (!res?.available) {
                return;
            }
            this.lastReport.positionMs = Number(res.positionMs) || 0;
            this.lastReport.bufferedMs = Number(res.bufferedMs) || 0;
            const durMs = Number(res.durationMs);
            if (Number.isFinite(durMs) && durMs > 0) {
                this.lastReport.durationMs = durMs;
            }
            this.lastReport.paused = !!res.paused;
            this._pausedOptimistic = null;
            if (res.ended && !this._ended) {
                this._ended = true;
                this.lastReport.paused = true;
                this.fire("ended");
            }
        } catch {
            // 探测失败保持现状
        }
    }

    /**
     * 查询原生播放器的真实状态（回前台对账用）。
     * 页面被系统冻结期间播放器可能已自行换了歌，JS 侧的对齐以这份状态为准。
     */
    async queryNativeState(): Promise<INativeAudioState | null> {
        try {
            const res = await callNativeMethod(PLUGIN, "getState");
            if (!res?.available) {
                return null;
            }
            return {
                currentMediaId: String(res.currentMediaId ?? ""),
                currentSrc: String(res.currentSrc ?? ""),
                position: (Number(res.positionMs) || 0) / 1000,
                duration: (Number(res.durationMs) || 0) / 1000,
                paused: !!res.paused,
                ended: !!res.ended,
                hasNext: !!res.hasNext,
            };
        } catch {
            return null;
        }
    }

    /**
     * 收养原生现状（极端对账：JS 侧代理与播放器完全脱节，如页面重建后）：
     * 不触碰原生播放器，只把代理内部状态对齐到原生现实。
     */
    adoptNativeState(state: INativeAudioState): void {
        this._src = state.currentSrc;
        this._hasSource = !!state.currentSrc;
        this._mediaId = state.currentMediaId;
        this._pendingSeekMs = null;
        this._error = null;
        this._ended = state.ended;
        this.lastReport.positionMs = state.position * 1000;
        if (state.duration > 0) {
            this.lastReport.durationMs = state.duration * 1000;
        }
        this.lastReport.paused = state.paused;
        this._pausedOptimistic = null;
    }

    private applyVolume() {
        const effective = this._muted ? 0 : this._volume;
        callNativeMethod(PLUGIN, "setVolume", { volume: effective }).catch(() => {});
    }

    private onNativeEvent(data: any) {
        const type = String(data?.type ?? "");
        if (!type) {
            return;
        }
        let payload: Record<string, any> | undefined;
        switch (type) {
            case "timeupdate": {
                // 原生每秒推一次进度：数值在载荷里（positionMs/bufferedMs/durationMs/paused）
                this._pendingSeekMs = null;
                const posMs = Number(data.positionMs);
                if (Number.isFinite(posMs)) {
                    this.lastReport.positionMs = posMs;
                }
                const bufMs = Number(data.bufferedMs);
                if (Number.isFinite(bufMs)) {
                    this.lastReport.bufferedMs = bufMs;
                }
                const durMs = Number(data.durationMs);
                if (Number.isFinite(durMs) && durMs > 0) {
                    this.lastReport.durationMs = durMs;
                }
                if (data.paused !== undefined) {
                    this.lastReport.paused = !!data.paused;
                }
                break;
            }
            case "durationchange": {
                const ms = Number(data.durationMs);
                this.lastReport.durationMs = Number.isFinite(ms) && ms > 0 ? ms : this.lastReport.durationMs;
                break;
            }            case "play": {
                this.lastReport.paused = false;
                this._pausedOptimistic = null;
                this._pendingSeekMs = null;
                this.settlePlay(true);
                break;
            }
            case "playing": {
                this._ended = false;
                this._error = null;
                this._pausedOptimistic = null;
                this.settlePlay(true);
                break;
            }
            case "pause": {
                this.lastReport.paused = true;
                this._pausedOptimistic = null;
                // 不能以 AbortError 拒绝挂起中的 play()：换歌时 detachAudio 对旧歌发的
                // pause 事件经桥回到 JS 有延迟，本地文件 / 已下载歌曲的音源解析是瞬时
                // 的，新歌的 play() 往往已先注册，会被这条「滞后 pause」误杀成
                // 「播放被新的请求中断」→ 弹失败提示 + 自动跳歌。起播瞬间的用户暂停、
                // 开播时被抢音频焦点同理，都只是暂停不是失败：以成功落定，调用方
                // 按 paused 状态决定是否翻播放态。
                this.settlePlay(true);
                break;
            }
            case "ended": {
                this._ended = true;
                this.lastReport.paused = true;
                this.settlePlay(true);
                break;
            }
            case "itemtransition": {
                // 原生自动续播了窗口里的下一首：src/mediaId 跟上播放器的现实
                const mediaId = String(data.mediaId ?? "");
                if (mediaId && this.windowItems.has(mediaId)) {
                    this._src = this.windowItems.get(mediaId)!.src;
                    this._mediaId = mediaId;
                } else if (mediaId) {
                    this._mediaId = mediaId;
                }
                this._ended = false;
                payload = { mediaId, index: Number(data.index) || 0 };
                break;
            }
            case "error": {
                // detail 是原生错误码（PlaybackException.errorCode），粗映射成 HTML 同形
                const code = Number(data.detail);
                this._error = new NativeMediaError(
                    Number.isFinite(code) && code > 0 ? mapNativeErrorCode(code) : 2,
                    `原生播放失败（code=${data.detail ?? "?"}）`,
                );
                this.settlePlay(false);
                break;
            }
            default:
                break;
        }
        this.fire(type, payload);
    }

    /**
     * play() promise 的落定：success=true 统一 resolve（播放已开始，或本次起播
     * 已被暂停 / 播完接管——暂停不是失败）；success=false 仅用于真正的失败
     * （error 事件、destroy），以 AbortError / 媒体错误拒绝。
     */
    private settlePlay(success: boolean) {
        if (success) {
            this.playRejecters.clear();
            this.playResolvers.forEach((r) => r());
            this.playResolvers.clear();
        } else {
            this.playResolvers.clear();
            this.playRejecters.forEach((r) =>
                r(this._error ?? Object.assign(new Error("playback failed"), { name: "AbortError" })),
            );
            this.playRejecters.clear();
        }
    }

    private fire(type: string, payload?: Record<string, any>) {
        const entries = [...(this.listeners.get(type) ?? [])];
        for (const entry of entries) {
            if (entry.once) {
                this.listeners.get(type)?.delete(entry);
            }
            try {
                entry.fn({ type, target: this, ...(payload ?? {}) });
            } catch {
                // 单个监听器抛错不阻断其他监听器
            }
        }
    }
}

/** PlaybackException.errorCode → HTMLMediaError.code 粗映射（与旧 NativeAudioPlugin.mapErrorCode 同规则） */
function mapNativeErrorCode(nativeCode: number): number {
    if (nativeCode >= 2000 && nativeCode < 3000) {
        return 2; // IO 类 → 网络
    }
    if (nativeCode >= 3000 && nativeCode < 4000) {
        return 4; // 解析/格式 → 不支持
    }
    if (nativeCode >= 1000 && nativeCode < 2000) {
        return 3; // 解码错误
    }
    return 2;
}

/**
 * 创建播放器后端：原生可用且非浏览器环境走 ExoPlayer 代理，否则 <audio>。
 * 同步分支返回 HTMLAudioElement；异步路径由调用方 await 后接入。
 */
export async function createAudioElement(): Promise<HTMLAudioElement | NativeAudioElement> {
    const ok = await probeNativeAudio();
    if (ok) {
        return new NativeAudioElement();
    }
    return new Audio();
}

/** 统一销毁（trackPlayer.destroyAudioElement 的适配） */
export function destroyAudioBackend(el: HTMLAudioElement | NativeAudioElement | null) {
    if (el instanceof NativeAudioElement) {
        el.destroy();
    } else if (el) {
        try {
            el.pause();
            el.removeAttribute("src");
            el.load();
        } catch {
            // ignore
        }
    }
}
