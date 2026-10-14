package com.huah.musicfree.hy;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioTrackBufferSizeProvider;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * 原生播放内核：Media3 MediaSessionService 托管 ExoPlayer。
 *
 * JS 只是遥控器（后台连播的根治）：
 *  - 音源解析只能在 WebView JS 里跑（音源插件机制），而熄屏后台的渲染进程
 *    会被部分 ROM 无视优先级建议直接冻结——「下一首放什么」的控制面不能依赖
 *    JS 存活。JS 把整条播放计划（元数据 + 可空 src）经 pushQueuePlan 交给这里，
 *    队列推进的状态机就此归原生：ExoPlayer 播完自动续播已解析的下一条，解析位
 *    不足时向 JS 发 needsource 索要音源（带周期重发，JS 醒来即可续上），JS 经
 *    supplySource 补源后若在等源则当场续播——全程不要求 JS 在场。
 *  - MediaSessionService 自带前台服务生命周期与系统媒体通知
 *    （DefaultMediaNotificationProvider）：元数据随 MediaItem 走，封面/标题/
 *    播放态由系统渲染，不再手写 MediaStyle 通知与封面解码。
 *  - ExoPlayer setWakeMode(WAKE_MODE_NETWORK) 自管唤醒锁，熄屏断流取流
 *    不再需要服务侧的 WakeLock/WifiLock 心跳。
 *
 * JS 侧经 PlaybackBridge 桥接：播放控制直达这里，状态事件原路转发。
 */
public class MediaPlaybackService extends MediaSessionService {

    private static final String TAG = "PlaybackService";

    /** ExoPlayer 播放列表里「当前曲之后」保留的可播条目上限（预载窗） */
    static final int QUEUE_WINDOW_MAX = 3;
    /** transition 后保留的已播条目数：通知栏/耳机「上一首」由原生直切 */
    private static final int KEEP_BEHIND = 2;
    /** 队列自愈的连续失败上限：连续这么多首取流失败才真正停下 */
    private static final int MAX_CONSECUTIVE_ERRORS = 5;
    /** 连续取流失败计数（成功开播即清零，见 onIsPlayingChanged） */
    private int consecutiveErrors = 0;
    /** 上一次播放器状态（READY→BUFFERING 的欠载哨兵用） */
    private int lastPlaybackState = Player.STATE_IDLE;
    /** 等源重发 needsource 的周期：JS 被强节流（1/min）/冻结醒来后仍能续上 */
    private static final long NEED_SOURCE_RETRY_MS = 12_000L;
    /** shadow 计划上限（防 JS 误推超长列表撑爆内存；对齐 JS 侧 PLAN_MAX 留余量） */
    private static final int PLAN_MAX = 300;

    /** 首次原生解析的等待：先给 JS 1.5s 走 needsource（活着就最快往返），没等到原生接管 */
    private static final long NATIVE_RESOLVE_DELAY_MS = 2_500L;
    /** 原生解析重试间隔（引擎还没同步好 / 网络抖动） */
    private static final long NATIVE_RESOLVE_RETRY_MS = 8_000L;
    /** 单条计划的原生解析次数上限：原生只是兜底，JS 的 needsource 一直都在 */
    private static final int MAX_NATIVE_RESOLVE_ATTEMPTS = 3;
    /** 原生解析总超时（QuickJS 内部每档 15s，这里给整条链兜底） */
    private static final long NATIVE_RESOLVE_TIMEOUT_MS = 20_000L;

    /**
     * 计划条目：JS 整条播放顺序在原生侧的镜像。src 为空 = 还没解析出音源
     * （解析本该在 WebView 插件里），轮到它时经 needsource 向 JS 索要；
     * payload/quality 是「JS 死了也能自救」的依据——原生 QuickJS 引擎可直接
     * 跑 getMediaSource，不再依赖 WebView 存活。
     */
    static final class Planned {
        final String mediaId;
        final String title;
        final String artist;
        final String album;
        final String artworkUri;
        /** 曲目快照 JSON（原生解析用；空 = JS 没给，只能靠 needsource） */
        final String payload;
        /** 请求音质档（low/standard/high/super；空 = standard） */
        final String quality;
        String src;
        /** 原生解析在途（防重入） */
        boolean resolving;
        /** 已用掉的原生解析次数（到 MAX_NATIVE_RESOLVE_ATTEMPTS 后只等 JS） */
        int resolveAttempts;

        Planned(String mediaId, String src, String title, String artist,
                String album, String artworkUri, String payload, String quality) {
            this.mediaId = mediaId;
            this.src = src == null ? "" : src;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artworkUri = artworkUri;
            this.payload = payload == null ? "" : payload;
            this.quality = quality == null ? "" : quality;
        }
    }

    /** 完整播放队列（当前可播窗之后）：推进状态机归原生，JS 只补源 */
    private final java.util.ArrayList<Planned> shadow = new java.util.ArrayList<>();
    /** 队列播尽但在等 JS 补源：补上即自动续播（区别于用户暂停） */
    private boolean awaitingSource = false;
    /** needsource 重发定时器（主线程 Handler） */
    private final Runnable needTick = new Runnable() {
        @Override
        public void run() {
            emitNeedSource();
            if (needsSourceNow()) {
                main.postDelayed(this, NEED_SOURCE_RETRY_MS);
            }
        }
    };

    /**
     * 原生自解析（L4 核心）：shadow 头部缺源且 JS 没在 2.5s 内补上，就由原生
     * QuickJS 引擎直接跑 getMediaSource —— WebView 被冻结/被杀也不再卡队列。
     * 与 needsource 并行推进：谁先把 src 写回来就用谁的。
     */
    private final Runnable nativeResolveTick = new Runnable() {
        @Override
        public void run() {
            nativeResolveScheduled = false;
            resolveHeadNatively();
        }
    };
    /** nativeResolveTick 是否已排（Handler.hasCallbacks 要 API 29，自维护） */
    private boolean nativeResolveScheduled = false;
    /** 原生解析线程池：PluginRuntime.resolve 是阻塞调用，绝不能压在主线程上 */
    private final java.util.concurrent.ExecutorService resolveExecutor =
        java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "native-plugin-resolve");
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
    /** 插件返回的请求头（按播放地址索引）：数据源 open 时按 URI 注入 */
    private final java.util.HashMap<String, java.util.HashMap<String, String>> headersByUri =
        new java.util.HashMap<>();

    /**
     * 播放状态变化回调（PlaybackBridge 注册，转发给 WebView 里的 JS）。
     * evt 取值：play / pause / playing / ended / error / itemtransition
     */
    public interface PlaybackListener {
        void onPlaybackEvent(String evt, String mediaId, String extra);
    }

    private static volatile PlaybackListener playbackListener;

    public static void setPlaybackListener(PlaybackListener listener) {
        playbackListener = listener;
    }

    static void emitPlaybackEvent(String evt, String mediaId, String extra) {
        PlaybackListener listener = playbackListener;
        if (listener != null) {
            try {
                listener.onPlaybackEvent(evt, mediaId, extra);
            } catch (Exception ignored) {
            }
        }
    }

    /** 带数值载荷的事件（positionMs/bufferedMs/durationMs 等，extra 为 JSON 字符串） */
    static void emitPlaybackData(String evt, String mediaId, String json) {
        PlaybackListener listener = playbackListener;
        if (listener != null) {
            try {
                listener.onPlaybackEvent(evt, mediaId, json);
            } catch (Exception ignored) {
            }
        }
    }

    private MediaSession mediaSession;
    private ExoPlayer player;
    /**
     * 音频焦点仲裁开关，默认 false（不入仲裁）。音乐应用与短视频/视频应用
     * 天然共场景：入仲裁则对方每次抢焦点我们都暂停（抖音高频抢焦点时表现为
     * 「反复暂停和启动」的拉锯），Android 音频焦点本就是建议性的、允许混音。
     * 设置页「允许与其他应用同时播放」可显式切回独占模式（true）。
     */
    private volatile boolean focusEnabled = false;
    /** 进度心跳：播放中每秒向 JS 推 timeupdate（对齐 HTMLAudioElement 节奏） */
    private static final long PROGRESS_INTERVAL_MS = 1000L;
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            if (player == null) {
                return;
            }
            if (player.isPlaying()) {
                // 数值走 JSON 载荷：JS 侧据 positionMs/bufferedMs/durationMs 更新快照
                emitPlaybackData(
                    "timeupdate",
                    currentMediaId(),
                    "{\"positionMs\":" + player.getCurrentPosition()
                        + ",\"bufferedMs\":" + player.getBufferedPosition()
                        + ",\"durationMs\":" + player.getDuration()
                        + ",\"paused\":" + !player.getPlayWhenReady() + "}"
                );
                main.postDelayed(this, PROGRESS_INTERVAL_MS);
            }
        }
    };
    /** 当前条目 mediaId → JS 侧地址（getState 返回 currentSrc 供对账收养用） */
    private static final android.util.LruCache<String, String> sSrcById =
        new android.util.LruCache<>(32);

    @Override
    public void onCreate() {
        super.onCreate();
        PlaybackBridge.activeService = this;
        player = createPlayer();
        mediaSession = new MediaSession.Builder(this, player).build();
        player.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                int index = player.getCurrentMediaItemIndex();
                // 摘除身后的旧条目，列表保持「最近 2 首 + 当前 + 窗口」：上一首可直切，
                // 列表也不会无限增长。摘的是已放过的条目，不影响正在播的这首。
                if (index > KEEP_BEHIND) {
                    player.removeMediaItems(0, index - KEEP_BEHIND);
                }
                // 消耗了一个可播位：从 shadow 补窗，不足则向 JS 索源
                afterQueueConsumed();
                emitPlaybackEvent("itemtransition", currentMediaId(), String.valueOf(index));
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitPlaybackEvent(isPlaying ? "playing" : "pause", currentMediaId(), null);
                if (isPlaying) {
                    consecutiveErrors = 0;
                    main.removeCallbacks(progressTick);
                    main.postDelayed(progressTick, PROGRESS_INTERVAL_MS);
                    // 暂停期间被取消的原生解析：真正出声了再排上
                    ensureNativeResolve();
                } else {
                    main.removeCallbacks(progressTick);
                }
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                // 播放态翻转（含焦点让位导致的暂停）：转成 play/pause 事件给 JS。
                // onIsPlayingChanged 不覆盖「缓冲中暂停/恢复」的边缘。
                emitPlaybackEvent(playWhenReady ? "play" : "pause", currentMediaId(), null);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                // 欠载哨兵：曾在出声、播放头推进中回到 BUFFERING = 真实卡顿
                // （换歌装载的 BUFFERING 前置状态不是 READY，不会误报）
                boolean midStreamUnderrun = playbackState == Player.STATE_BUFFERING
                    && lastPlaybackState == Player.STATE_READY
                    && player != null
                    && player.getPlayWhenReady()
                    && player.getCurrentPosition() > 0;
                lastPlaybackState = playbackState;
                if (midStreamUnderrun) {
                    emitPlaybackEvent("waiting", currentMediaId(), null);
                }
                if (playbackState == Player.STATE_READY) {
                    // 时长就绪：JS 侧进度条/窗口镜像依赖它
                    emitPlaybackData(
                        "durationchange",
                        currentMediaId(),
                        "{\"durationMs\":" + player.getDuration() + "}"
                    );
                }
                if (playbackState == Player.STATE_ENDED) {
                    boolean hadIntent = player.getPlayWhenReady();
                    if (!shadow.isEmpty() && hadIntent) {
                        // 队列没放完、播放意图还在，只是下一条还没有音源：先尝试补窗
                        // （竞态下头条目可能恰好已解析），补不出可播条目才进等源态。
                        // JS 醒着会经 needsource 补源当场续播；真被冻结也只在
                        // 通知栏可见地暂停，回前台对账或 JS 定时器醒来仍能续上
                        refillWindow();
                        if (player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount()) {
                            player.seekToNextMediaItem();
                            player.prepare();
                            player.setPlayWhenReady(true);
                        } else {
                            awaitingSource = true;
                            player.seekTo(0);
                            player.setPlayWhenReady(false);
                            scheduleNeedTick();
                            ensureNativeResolve();
                        }
                    } else {
                        // 真播到了队尾（或用户本就暂停着）：翻暂停态，
                        // 通知栏显示播放键——与旧的队列耗尽语义一致
                        player.seekTo(0);
                        player.setPlayWhenReady(false);
                    }
                    emitPlaybackEvent("ended", currentMediaId(), null);
                }
            }

            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                // 队列自愈：坏条目（直链过期/音源失效）不让整条队列停下——
                // JS 冻结时 error 事件无人处理，若停在坏条目上就是「后台播几首
                // 后自动暂停」的最终形态。跳到下一首继续播；连续多首全失败
                // 才真正放弃（整队坏源时避免静默空转烧电）。
                refillWindow(); // 坏条目身后可能还有已补源的计划条目
                boolean recovered = false;
                if (player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount()) {
                    // ERROR 态下播放器已停止：seek + prepare 后必须重新声明
                    // playWhenReady=true 才会真正续播（prepare 不继承播放意图）
                    player.seekToNextMediaItem();
                    player.prepare();
                    player.setPlayWhenReady(true);
                    recovered = true;
                } else if (!shadow.isEmpty() && player.getPlayWhenReady()) {
                    // 身后只剩未解析条目：进等源态，needsource + 原生解析双路续命
                    awaitingSource = true;
                    scheduleNeedTick();
                    ensureNativeResolve();
                }
                consecutiveErrors = recovered ? consecutiveErrors + 1 : 0;
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    recovered = false;
                    consecutiveErrors = 0;
                    player.setPlayWhenReady(false);
                }
                emitPlaybackEvent(
                    "error",
                    currentMediaId(),
                    (error == null ? "unknown" : String.valueOf(error.errorCode))
                        + (recovered ? "|skip" : "")
                );
            }
        });
    }

    @OptIn(markerClass = UnstableApi.class)
    private ExoPlayer createPlayer() {
        // 网络 + 本地文件统一走 OkHttp 数据源：音源插件常有自定义请求头（UA/Referer）
        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();
        // OkHttp 默认跟随跨协议重定向（网易外链 302 https→http 也能落到），只补 UA
        HttpDataSource.Factory httpFactory = new OkHttpDataSource.Factory(client)
            .setUserAgent("Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 MusicFreeHy");
        // 原生解析拿到的插件请求头（Referer/Cookie/自定义 UA）按播放地址注入：
        // ResolvingDataSource 在 open 前改写 DataSpec，httpRequestHeaders 会被
        // HttpDataSource 原样带上。只有原生解析过的地址才有记录，
        // JS 补的源行为与旧版完全一致。
        ResolvingDataSource.Factory headerInjectingFactory = new ResolvingDataSource.Factory(
            httpFactory,
            new ResolvingDataSource.Resolver() {
                @Override
                public DataSpec resolveDataSpec(DataSpec dataSpec) {
                    java.util.HashMap<String, String> extra =
                        headersByUri.get(dataSpec.uri.toString());
                    if (extra != null && !extra.isEmpty()) {
                        java.util.HashMap<String, String> merged =
                            new java.util.HashMap<>(dataSpec.httpRequestHeaders);
                        merged.putAll(extra);
                        dataSpec = dataSpec.buildUpon()
                            .setHttpRequestHeaders(merged)
                            .build();
                    }
                    return dataSpec;
                }
            });
        DataSource.Factory dataSourceFactory =
            new DefaultDataSource.Factory(this, headerInjectingFactory);

        // 大缓冲：至少缓冲 30s、最多 60s 再开播不等待；回退阈值 5s。
        // 抖音在前台抢带宽时，存量缓冲决定我们会不会当场卡住。
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                30_000,   // minBufferMs：持续缓冲水位
                60_000,   // maxBufferMs：目标缓冲上限
                1_000,    // bufferForPlaybackMs：起播需要的最小缓冲
                5_000     // bufferForPlaybackAfterRebufferMs：卡顿后恢复阈值
            )
            .build();

        // 音频输出缓冲下限 500ms（平台默认约 20~100ms）：其他应用冷启动的调度
        // 尖峰（CPU/IO 被抢占、音频线程短暂饿死）只要不超过这个余量，AudioTrack
        // 靠存量数据顶着继续出声，听感上就是「无感平滑」。这是「启动其他应用
        // 瞬间卡一下」的直接对策——调度尖峰无法消除，但可以被输出缓冲吸收。
        // Media3 的 ExoPlayer.Builder 没有直接的 setAudioSink，经 RenderersFactory
        // 覆写 buildAudioSink 注入。
        DefaultRenderersFactory renderersFactory =
            new DefaultRenderersFactory(this) {
                @Override
                protected AudioSink buildAudioSink(
                    Context context,
                    boolean enableFloatOutput,
                    boolean enableAudioTrackPlaybackParams) {
                    return new DefaultAudioSink.Builder(context)
                        .setAudioTrackBufferSizeProvider(
                            new DefaultAudioTrackBufferSizeProvider.Builder()
                                .setMinPcmBufferDurationUs(500_000) // 500ms（单位：微秒）
                                .build())
                        .build();
                }
            };

        ExoPlayer p = new ExoPlayer.Builder(this)
            .setRenderersFactory(renderersFactory)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
            .setLoadControl(loadControl)
            .setPriority(C.PRIORITY_PLAYBACK)
            .build();
        // WAKE_MODE_NETWORK：播放/缓冲期间持有唤醒锁 + WiFi 锁，熄屏取流不断
        p.setWakeMode(C.WAKE_MODE_NETWORK);
        p.setHandleAudioBecomingNoisy(true);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build();
        p.setAudioAttributes(attrs, focusEnabled);
        return p;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务划掉应用：连 UI 都没了就不再出声（与旧版一致）。
        // 只停播放、退出前台身份，不销毁服务——进程保活交给系统。
        Player p = mediaSession != null ? mediaSession.getPlayer() : null;
        if (p != null) {
            p.stop();
            p.clearMediaItems();
        }
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(progressTick);
        main.removeCallbacks(needTick);
        cancelNativeResolve();
        resolveExecutor.shutdownNow();
        shadow.clear();
        if (PlaybackBridge.activeService == this) {
            PlaybackBridge.activeService = null;
        }
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    @androidx.annotation.Nullable
    @Override
    public MediaSession onGetSession(
        androidx.media3.session.MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    // ---------- PlaybackBridge 调用的内部入口（统一切主线程） ----------

    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    void runOnMain(java.util.concurrent.ExecutorService unused, Runnable r) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            r.run();
        } else {
            main.post(r);
        }
    }

    void runOnMain(Runnable r) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            r.run();
        } else {
            main.post(r);
        }
    }

    boolean hasPlayer() {
        return player != null;
    }

    /**
     * 单曲装载（对应旧的 setSource 语义）：替换整条播放列表为这一首。
     * autoplay=true 立即开播。整条计划作废（新起一首，计划由 JS 随后重推）。
     */
    void loadTrack(String src, String mediaId, long startMs, boolean autoplay,
                   String title, String artist, String album, String artworkUri) {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            player.stop();
            player.clearMediaItems();
            sSrcById.evictAll();
            shadow.clear();
            awaitingSource = false;
            main.removeCallbacks(needTick);
            cancelNativeResolve();
            if (src == null || src.isEmpty()) {
                return;
            }
            rememberSrc(mediaId, src);
            player.setMediaItem(buildItem(src, mediaId, title, artist, album, artworkUri),
                Math.max(startMs, 0L));
            player.prepare();
            player.setPlayWhenReady(autoplay);
        });
    }

    /**
     * 整条播放计划入档（JS 遥控器 → 原生状态机）：替换当前可播窗之后的 shadow
     * 队列。src 为空的条目表示「顺序已定但音源未解析」，轮到它时经 needsource
     * 向 JS 索要。已在 ExoPlayer 列表里的条目保持原样（不重建、通知栏不闪），
     * 新计划里与它们同 mediaId 的被剔除，剩下的从窗尾继续补窗。
     */
    void pushQueuePlan(java.util.List<Planned> plan) {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            java.util.HashSet<String> inPlayer = new java.util.HashSet<>();
            for (int i = Math.max(player.getCurrentMediaItemIndex(), 0) + 1;
                 i < player.getMediaItemCount(); i++) {
                MediaItem it = player.getMediaItemAt(i);
                if (it != null && it.mediaId != null && !it.mediaId.isEmpty()) {
                    inPlayer.add(it.mediaId);
                }
            }
            shadow.clear();
            for (Planned p : plan) {
                if (p == null || p.mediaId == null || p.mediaId.isEmpty()) {
                    continue;
                }
                if (inPlayer.contains(p.mediaId)) {
                    continue;
                }
                if (shadow.size() >= PLAN_MAX) {
                    break;
                }
                shadow.add(p);
            }
            if (plan.isEmpty()) {
                // 计划清空（换歌/队列清空/单曲循环）：身后残留的窗口一并撤下，
                // 否则 ExoPlayer 会续播 JS 已不认的歌。
                // awaitingSource 保留：随后紧来的新计划若带可播头条目，仍应按
                // 未中断的播放意图续播（撤下旧窗不等于用户暂停）
                dropNextSources();
                main.removeCallbacks(needTick);
            }
            afterQueueConsumed();
        });
    }

    /** 补一条已解析音源：shadow 命中换 src，窗内命中就地替换；等源态可当场续播 */
    void supplySource(String mediaId, String src) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()
                || src == null || src.isEmpty()) {
                return;
            }
            boolean replaced = false;
            for (Planned p : shadow) {
                if (mediaId.equals(p.mediaId)) {
                    p.src = src;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                for (int i = 0; i < player.getMediaItemCount(); i++) {
                    MediaItem it = player.getMediaItemAt(i);
                    if (it != null && mediaId.equals(it.mediaId)
                        && i > player.getCurrentMediaItemIndex()) {
                        // 已入窗的条目升级本地文件/换新直链：就地替换 URI（元数据随旧条目保留）
                        player.replaceMediaItem(i,
                            it.buildUpon().setUri(resolveSrc(src)).build());
                        replaced = true;
                        break;
                    }
                }
            }
            if (!replaced) {
                return; // JS 计划里已没有这首（换队列了）：丢弃
            }
            rememberSrc(mediaId, src);
            afterQueueConsumed();
        });
    }

    /** 撤下一条计划（JS 解析失败/冷却）：shadow 或窗内命中都移除 */
    void dropPlanned(String mediaId) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()) {
                return;
            }
            for (int i = shadow.size() - 1; i >= 0; i--) {
                if (mediaId.equals(shadow.get(i).mediaId)) {
                    shadow.remove(i);
                }
            }
            for (int i = player.getMediaItemCount() - 1;
                 i > player.getCurrentMediaItemIndex(); i--) {
                MediaItem it = player.getMediaItemAt(i);
                if (it != null && mediaId.equals(it.mediaId)) {
                    player.removeMediaItems(i, i + 1);
                }
            }
            afterQueueConsumed();
        });
    }

    /** 把 shadow 头部的已解析条目补进 ExoPlayer 窗（≤QUEUE_WINDOW_MAX） */
    private void refillWindow() {
        if (player == null) {
            return;
        }
        int window = player.getMediaItemCount() - player.getCurrentMediaItemIndex() - 1;
        while (window < QUEUE_WINDOW_MAX && !shadow.isEmpty()) {
            Planned head = shadow.get(0);
            if (head.src == null || head.src.isEmpty()) {
                break; // 队列推进到这里时需要 needsource 往返
            }
            shadow.remove(0);
            rememberSrc(head.mediaId, head.src);
            player.addMediaItem(buildItem(
                head.src, head.mediaId, head.title, head.artist, head.album, head.artworkUri));
            window++;
        }
    }

    /** 队列可播位可能被消耗（transition/补源/撤条目/换计划）：补窗并按需索源 */
    private void afterQueueConsumed() {
        refillWindow();
        if (needsSourceNow()) {
            scheduleNeedTick();
        } else {
            main.removeCallbacks(needTick);
        }
        // 缺源兜底：JS 没在窗口内补上就由原生引擎自己解析（与 needsource 并行）
        ensureNativeResolve();
        autoResumeIfAwaiting();
    }

    /** 等源态 + 补上了可播条目：当场续播（不依赖回前台对账）。
     *  awaitingSource 只在播放意图下成立，等源期的「暂停」是我们自己翻的，
     *  所以这里不能再看 playWhenReady（它正是我们置为 false 的）。 */
    private void autoResumeIfAwaiting() {
        if (player == null || !awaitingSource) {
            return;
        }
        if (player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount()) {
            awaitingSource = false;
            main.removeCallbacks(needTick);
            // ERROR/ENDED 态下 prepare 不继承播放意图，seek+prepare 后要显式重申
            player.seekToNextMediaItem();
            player.prepare();
            player.setPlayWhenReady(true);
        }
    }

    private boolean needsSourceNow() {
        if (player == null || shadow.isEmpty()) {
            return false;
        }
        boolean intentOrAwaiting = player.getPlayWhenReady() || awaitingSource;
        if (!intentOrAwaiting) {
            return false; // 用户暂停中不索源：恢复播放时 JS 会重推计划
        }
        return shadow.get(0).src.isEmpty();
    }

    private void scheduleNeedTick() {
        main.removeCallbacks(needTick);
        main.postDelayed(needTick, 1_500L); // 首播快发（JS 活着就立刻往返），之后按周期
    }

    private void emitNeedSource() {
        if (player == null || shadow.isEmpty()) {
            return;
        }
        String head = shadow.get(0).mediaId;
        emitPlaybackData(
            "needsource",
            head,
            "{\"mediaId\":\"" + head + "\",\"plannedCount\":" + shadow.size() + "}"
        );
    }

    /** ---------------- 原生自解析：缺源时 QuickJS 引擎接手 ---------------- */

    private void scheduleNativeResolve(long delayMs) {
        if (nativeResolveScheduled) {
            return;
        }
        nativeResolveScheduled = true;
        main.postDelayed(nativeResolveTick, delayMs);
    }

    private void cancelNativeResolve() {
        main.removeCallbacks(nativeResolveTick);
        nativeResolveScheduled = false;
    }

    /**
     * shadow 头部缺源且还该由原生接手：排一次解析。
     * 首次多等 2.5s（JS 活着就先走 needsource 往返，比原生快），没等到才原生上；
     * 暂停中/已排/次数用尽都不动。
     */
    private void ensureNativeResolve() {
        if (player == null || shadow.isEmpty()) {
            cancelNativeResolve();
            return;
        }
        Planned head = shadow.get(0);
        if (!head.src.isEmpty()
            || head.resolving
            || head.payload.isEmpty()
            || head.resolveAttempts >= MAX_NATIVE_RESOLVE_ATTEMPTS
            || !(player.getPlayWhenReady() || awaitingSource)) {
            cancelNativeResolve();
            return;
        }
        if (nativeResolveScheduled) {
            return;
        }
        scheduleNativeResolve(
            head.resolveAttempts == 0 ? NATIVE_RESOLVE_DELAY_MS : NATIVE_RESOLVE_RETRY_MS);
    }

    /** 发起一次原生解析（主线程判定；真正阻塞的 PluginRuntime.resolve 丢到 resolveExecutor） */
    private void resolveHeadNatively() {
        if (player == null || shadow.isEmpty()) {
            return;
        }
        final Planned head = shadow.get(0);
        if (!head.src.isEmpty()
            || head.resolving
            || head.payload.isEmpty()
            || head.resolveAttempts >= MAX_NATIVE_RESOLVE_ATTEMPTS
            || !(player.getPlayWhenReady() || awaitingSource)) {
            return;
        }
        head.resolving = true;
        head.resolveAttempts++;
        // 预排下一次兜底：成功路径会经 ensureNativeResolve 把它撤掉
        if (head.resolveAttempts < MAX_NATIVE_RESOLVE_ATTEMPTS) {
            scheduleNativeResolve(NATIVE_RESOLVE_RETRY_MS);
        }
        final String mediaId = head.mediaId;
        final String itemJson = head.payload;
        final String quality = head.quality == null || head.quality.isEmpty()
            ? "standard"
            : head.quality;
        Log.i(TAG, "原生自解析发起：" + mediaId
            + "（第" + head.resolveAttempts + "次，音质 " + quality + "）");
        resolveExecutor.execute(() -> {
            String res = null;
            try {
                res = PluginRuntime.getInstance(getApplicationContext())
                    .resolve(itemJson, quality, "", NATIVE_RESOLVE_TIMEOUT_MS);
            } catch (Throwable t) {
                res = null;
            }
            final String resultJson = res;
            runOnMain(() -> applyNativeResolve(mediaId, resultJson));
        });
    }

    /**
     * 原生解析结果写回：只在「这条还在计划里、src 仍为空、JS 没抢先补源」时生效，
     * 否则作废（JS 的直链优先，不覆盖）。失败则按次数上限重排，用尽后只等 needsource。
     */
    private void applyNativeResolve(String mediaId, String resultJson) {
        if (player == null || mediaId == null || mediaId.isEmpty()) {
            return;
        }
        Planned target = null;
        for (Planned p : shadow) {
            if (mediaId.equals(p.mediaId)) {
                target = p;
                break;
            }
        }
        if (target == null) {
            Log.i(TAG, "原生自解析结果作废（计划已换）：" + mediaId);
            return; // 计划换了：结果作废
        }
        target.resolving = false;
        if (!target.src.isEmpty()) {
            Log.i(TAG, "原生自解析结果作废（JS 已补源）：" + mediaId);
            return; // JS 已补上：不覆盖
        }
        String url = "";
        if (resultJson != null && !resultJson.isEmpty()) {
            try {
                JSONObject res = new JSONObject(resultJson);
                if (res.optBoolean("ok", false)) {
                    url = res.optString("url", "");
                }
            } catch (Exception ignored) {
            }
        }
        if (url.isEmpty()) {
            Log.i(TAG, "原生自解析失败：" + mediaId
                + "（剩余 " + Math.max(0, MAX_NATIVE_RESOLVE_ATTEMPTS - target.resolveAttempts)
                + " 次，继续等 needsource）");
            ensureNativeResolve();
            return;
        }
        Log.i(TAG, "原生自解析成功：" + mediaId + " -> " + url);
        target.src = url;
        rememberSrc(mediaId, url);
        rememberHeadersFor(url, resultJson);
        afterQueueConsumed(); // 补窗 +（等源态则）续播 + 下一轮 ensure
    }

    /** 记住插件返回的请求头（按播放地址索引），数据源 open 时按 URI 注入 */
    private void rememberHeadersFor(String url, String resultJson) {
        try {
            JSONObject res = new JSONObject(resultJson);
            java.util.HashMap<String, String> map = new java.util.HashMap<>();
            JSONObject headers = res.optJSONObject("headers");
            if (headers != null) {
                java.util.Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String key = it.next();
                    String value = headers.optString(key, "");
                    if (!value.isEmpty()) {
                        map.put(key, value);
                    }
                }
            }
            String ua = res.optString("userAgent", "");
            if (!ua.isEmpty()) {
                boolean hasUa = false;
                for (String k : map.keySet()) {
                    if ("user-agent".equalsIgnoreCase(k)) {
                        hasUa = true;
                        break;
                    }
                }
                if (!hasUa) {
                    map.put("User-Agent", ua);
                }
            }
            if (map.isEmpty()) {
                return;
            }
            headersByUri.put(url, map);
            while (headersByUri.size() > 64) {
                java.util.Iterator<String> first = headersByUri.keySet().iterator();
                first.next();
                first.remove();
            }
        } catch (Exception ignored) {
        }
    }

    /** 移除当前曲目之后的全部条目（预载位）。
     *  removeMediaItems(from, to) 的第二个参数是排他结束下标，不是个数：
     *  删 [from, count) 要传 count——传 count-from 会在 from > count-from 时
     *  触发断言崩溃（列表里有已播条目后必然发生）。 */
    private void dropNextSources() {
        if (player == null) {
            return;
        }
        int from = Math.max(player.getCurrentMediaItemIndex() + 1, 1);
        int count = player.getMediaItemCount();
        if (count > from) {
            player.removeMediaItems(from, count);
        }
    }

    void play() {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            player.setPlayWhenReady(true);
            // 播完停下后按播放：补上了源就继续连播（与 STATE_ENDED 的自动续播同语义）
            if (player.getPlaybackState() == Player.STATE_ENDED) {
                refillWindow();
                if (player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount()) {
                    player.seekToNextMediaItem();
                    player.prepare();
                    player.setPlayWhenReady(true);
                }
            }
            ensureNativeResolve();
        });
    }

    void pause() {
        runOnMain(() -> {
            if (player != null) {
                player.setPlayWhenReady(false);
            }
        });
    }

    void stop() {
        runOnMain(() -> {
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            sSrcById.evictAll();
            shadow.clear();
            awaitingSource = false;
            main.removeCallbacks(needTick);
            cancelNativeResolve();
        });
    }

    void seekTo(long positionMs) {
        runOnMain(() -> {
            if (player != null) {
                player.seekTo(Math.max(positionMs, 0L));
            }
        });
    }

    /** 原生队列直切（须主线程调用，PlaybackBridge.runOnMain 已保证）：
     *  有目标返回 mediaId，没有返回 null（JS 走常规换歌） */
    String skip(int direction) {
        if (player == null
            || android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            return null;
        }
        int index = player.getCurrentMediaItemIndex();
        int target = direction > 0 ? index + 1 : index - 1;
        if (target < 0 || target >= player.getMediaItemCount()) {
            return null;
        }
        player.seekTo(target, 0L);
        player.setPlayWhenReady(true);
        String mediaId = currentMediaId();
        return mediaId.isEmpty() ? null : mediaId;
    }

    /**
     * 跳到队列里的指定条目（JS 手动点播「计划内已有源」的歌时走这里）：
     * 不重建列表（loadTrack 会清空当前曲之后的全部条目，通知栏「下一首」
     * 图标随尾部清空闪烁，重镜像的解析延迟让闪烁肉眼可见）。命中返回
     * mediaId（过渡由 itemtransition 统一簿记，与 skip 同路），未命中返回
     * null（JS 回退常规换歌链路）。shadow 深处的条目先撤下它之前的计划
     * （用户点的是这首，中间的被跳过），再入窗定点。
     */
    String jumpToMediaItem(String mediaId) {
        if (player == null || mediaId == null || mediaId.isEmpty()
            || android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            return null;
        }
        if (mediaId.equals(currentMediaId())) {
            return null;
        }
        for (int i = 0; i < player.getMediaItemCount(); i++) {
            MediaItem item = player.getMediaItemAt(i);
            if (item != null && mediaId.equals(item.mediaId)) {
                player.seekTo(i, 0L);
                player.setPlayWhenReady(true);
                return mediaId;
            }
        }
        int at = -1;
        for (int i = 0; i < shadow.size(); i++) {
            if (mediaId.equals(shadow.get(i).mediaId)) {
                at = i;
                break;
            }
        }
        if (at < 0 || shadow.get(at).src.isEmpty()) {
            return null;
        }
        shadow.subList(0, at + 1).clear();
        refillWindow();
        int targetIndex = -1;
        for (int i = 0; i < player.getMediaItemCount(); i++) {
            MediaItem item = player.getMediaItemAt(i);
            if (item != null && mediaId.equals(item.mediaId)) {
                targetIndex = i;
                break;
            }
        }
        if (targetIndex < 0) {
            return null; // 防御：理论不可能（refill 上限覆盖）
        }
        player.seekTo(targetIndex, 0L);
        player.prepare();
        player.setPlayWhenReady(true);
        afterQueueConsumed();
        return mediaId;
    }

    void setRate(float rate) {
        runOnMain(() -> {
            if (player != null) {
                player.setPlaybackSpeed(Math.min(Math.max(rate, 0.05f), 4f));
            }
        });
    }

    void setVolume(float volume) {
        runOnMain(() -> {
            if (player != null) {
                player.setVolume(Math.min(Math.max(volume, 0f), 1f));
            }
        });
    }

    /** repeatMode: off | single（队列随机/顺序由 JS 侧算窗口，原生只认单曲循环） */
    void setRepeatMode(boolean repeatOne) {
        runOnMain(() -> {
            if (player != null) {
                player.setRepeatMode(repeatOne ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            }
        });
    }

    void setAudioFocusMode(boolean focusOn) {
        focusEnabled = focusOn;
        runOnMain(() -> {
            if (player != null) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build();
                player.setAudioAttributes(attrs, focusEnabled);
            }
        });
    }

    // ---------- 状态查询（PlaybackBridge.getState 用，须在主线程调） ----------

    String currentMediaId() {
        if (player == null) {
            return "";
        }
        MediaItem item = player.getCurrentMediaItem();
        return item == null || item.mediaId == null ? "" : item.mediaId;
    }

    String currentSrc() {
        String id = currentMediaId();
        return id.isEmpty() ? "" : (sSrcById.get(id) == null ? "" : sSrcById.get(id));
    }

    long currentPositionMs() {
        return player == null ? 0L : player.getCurrentPosition();
    }

    long currentBufferedMs() {
        return player == null ? 0L : player.getBufferedPosition();
    }

    long currentDurationMs() {
        return player == null ? C.TIME_UNSET : player.getDuration();
    }

    boolean isPaused() {
        return player == null || !player.getPlayWhenReady();
    }

    boolean isEnded() {
        return player != null && player.getPlaybackState() == Player.STATE_ENDED;
    }

    boolean isPlaying() {
        return player != null && player.isPlaying();
    }

    boolean hasNext() {
        if (player == null) {
            return false;
        }
        return player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount();
    }

    /** 等源态：队列未完但下一条缺音源，播放已停（补源即自动续播） */
    boolean isAwaitingSource() {
        return awaitingSource;
    }

    /** shadow 里剩余的未入窗计划条目数（对账用；不含 ExoPlayer 窗内的） */
    int plannedCount() {
        return shadow.size();
    }

    /** shadow 头条目（JS 补源的对象）；没有则空串 */
    String plannedHeadMediaId() {
        return shadow.isEmpty() ? "" : shadow.get(0).mediaId;
    }

    float currentRate() {
        return player == null ? 1f : player.getPlaybackParameters().speed;
    }

    float currentVolume() {
        return player == null ? 1f : player.getVolume();
    }

    // ---------- 内部 ----------

    private void rememberSrc(String mediaId, String src) {
        if (mediaId != null && !mediaId.isEmpty() && src != null && !src.isEmpty()) {
            sSrcById.put(mediaId, src);
        }
    }

    private MediaItem buildItem(String src, String mediaId,
                                String title, String artist, String album, String artworkUri) {
        MediaItem.Builder builder = new MediaItem.Builder()
            .setUri(resolveSrc(src));
        if (mediaId != null && !mediaId.isEmpty()) {
            builder.setMediaId(mediaId);
        }
        MediaMetadata.Builder meta = new MediaMetadata.Builder();
        if (title != null && !title.isEmpty()) {
            meta.setTitle(title);
        }
        if (artist != null && !artist.isEmpty()) {
            meta.setArtist(artist);
        }
        if (album != null && !album.isEmpty()) {
            meta.setAlbumTitle(album);
        }
        if (artworkUri != null && !artworkUri.isEmpty()) {
            meta.setArtworkUri(Uri.parse(artworkUri));
        }
        builder.setMediaMetadata(meta.build());
        return builder.build();
    }

    /** src 归一化：capacitor 文件地址还原为 file:// 绝对路径（ExoPlayer 文件数据源需要 scheme） */
    private String resolveSrc(String src) {
        int fileMark = src.indexOf("/_capacitor_file_");
        if (fileMark >= 0) {
            return "file://" + src.substring(fileMark + "/_capacitor_file_".length());
        }
        return src;
    }
}
