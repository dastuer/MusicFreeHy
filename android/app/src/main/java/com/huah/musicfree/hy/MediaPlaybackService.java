package com.huah.musicfree.hy;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.util.UnstableApi;
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
import androidx.media3.exoplayer.source.ShuffleOrder;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * 原生播放内核：Media3 MediaSessionService 托管 ExoPlayer。
 *
 * ## 队列权威在原生（v1.0.15 架构）
 *
 * **整条播放队列进 ExoPlayer**，队列条目携带元数据 + 曲目快照（payload），
 * 音源地址惰性解析：条目以占位 URI `mfhy://<mediaId>` 进列表，ExoPlayer
 * 预缓冲到它（比出声早 30~60s）时才经 {@link LazyAudioDataSource} 向
 * {@link PluginRuntime}（QuickJS）要真实直链。
 *
 * 这样做的收益（取代了 v1.0.12~1.0.14 的「shadow 计划队列 + 可播窗 +
 * needsource 拉取协议 + 窗口镜像」那一整套）：
 *  - **解析时机贴近播放**：直链不再在推送队列时就解析、躺在计划里几小时过期；
 *  - **连播长度不受窗口限制**：整队都在播放器里，没有「窗耗尽」这回事；
 *  - **shuffle/repeat 归原生**：Media3 的 ShuffleOrder 与 REPEAT_MODE_*，
 *    JS 不再需要模拟消费来算下一首；
 *  - JS 退化为纯遥控器：装载队列、报顺序、UI/历史——被冻结或被杀也不影响续播。
 *
 * 队列快照落盘（含 payload）让进程被回收后能恢复；`onPlaybackResumption`
 * 让系统媒体恢复卡片可用。
 */
public class MediaPlaybackService extends MediaSessionService {

    private static final String TAG = "PlaybackService";

    /** 接受的最大队列长度（JS 歌单上限 500，留余量；防误推超长列表撑爆内存） */
    private static final int MAX_QUEUE_SIZE = 2000;
    /** 队列自愈的连续失败上限：连续这么多首取流失败才真正停下 */
    private static final int MAX_CONSECUTIVE_ERRORS = 5;
    /** 连续取流失败计数（成功开播即清零，见 onIsPlayingChanged） */
    private int consecutiveErrors = 0;
    /** 上一次播放器状态（READY→BUFFERING 的欠载哨兵用） */
    private int lastPlaybackState = Player.STATE_IDLE;

    /** 单条音源解析超时（QuickJS 内部每档 15s，这里给整条链兜底） */
    private static final long RESOLVE_TIMEOUT_MS = 20_000L;
    /** 同一条目「同源失败后重解析」的次数上限（防止坏源无限重试烧电） */
    private static final int MAX_RESOLVE_RETRIES = 2;

    /**
     * 计划条目：JS 播放队列在原生侧的镜像。src 为空 = 还没解析出音源
     * （由 {@link LazyAudioDataSource} 在临播前用 payload 自己解析）；
     * payload/quality 就是「JS 死了也能自救」的依据。
     */
    static final class Planned {
        final String mediaId;
        final String title;
        final String artist;
        final String album;
        final String artworkUri;
        /** 曲目快照 JSON（原生解析用；空 = 这条原生解析不了） */
        final String payload;
        /** 请求音质档（low/standard/high/super；空 = standard） */
        final String quality;
        /** JS 已解析好的地址（本地文件 / 缓存命中 / 直链）；空 = 交给原生解析 */
        String src;

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

    /** mediaId → 计划条目（惰性解析查它取 payload；也用队列快照恢复） */
    private final android.util.LruCache<String, Planned> plannedById =
        new android.util.LruCache<>(2048);
    /**
     * mediaId → 已解析的直链（惰性解析的缓存）。命中就复用，避免每次
     * open 都跑一遍插件；条目取流失败时清掉它，下次 open 自然会重新解析
     * ——这就是「换源重试」的全部实现（不需要另起一套重试状态机）。
     */
    private final HashMap<String, String> resolvedSrcByMediaId = new HashMap<>();
    /** mediaId → 刚失败的直链（重解析时作 excludeUrl 传给插件换一条源） */
    private final HashMap<String, String> failedSrcByMediaId = new HashMap<>();
    /** mediaId → 已重试次数（坏源不能无限重试；成播放功即清） */
    private final HashMap<String, Integer> resolveRetries = new HashMap<>();
    /** 插件返回的请求头（按播放地址索引）：数据源 open 时按 URI 注入 */
    private final HashMap<String, HashMap<String, String>> headersByUri = new HashMap<>();
    /** 当前条目 mediaId → JS 侧地址（getState 返回 currentSrc 供对账收养用） */
    private static final android.util.LruCache<String, String> sSrcById =
        new android.util.LruCache<>(64);

    /** 解析线程池：PluginRuntime.resolve 是阻塞调用，绝不压在主线程上 */
    private final ExecutorService resolveExecutor =
        Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "native-plugin-resolve");
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });

    /** ---------------- 队列持久化（进程/服务被杀后冷启动恢复） ---------------- */

    private static final String QUEUE_STATE_FILE = "playback-queue.json";
    /** 落盘去抖：队列变动/进度更新都很频繁，攒一下再写 */
    private static final long QUEUE_PERSIST_DEBOUNCE_MS = 1_200L;
    private File queueStateFile;
    private final Runnable persistQueueTick = new Runnable() {
        @Override
        public void run() {
            persistQueueScheduled = false;
            writeQueueState();
        }
    };
    private boolean persistQueueScheduled = false;
    /** 队列恢复中：期间不落盘、不打扰（避免把半恢复状态写成新快照） */
    private boolean restoringQueue = false;
    private final ExecutorService persistExecutor =
        Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "queue-persist");
            t.setPriority(Thread.MIN_PRIORITY);
            return t;
        });

    /**
     * 播放状态变化回调（PlaybackBridge 注册，转发给 WebView 里的 JS）。
     * evt 取值：play / pause / playing / ended / error / itemtransition /
     * timeupdate / durationchange / waiting
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
    /**
     * 音频硬件直通（Audio Offload）开关，默认 true。
     *
     * 「打开其他应用时卡顿」的根因是**应用 CPU 被对方冷启动抢占**：普通路径下
     * ExoPlayer 的渲染/灌音线程要被调度才出声，被饿死就欠载、听感卡顿（大输出
     * 缓冲只能吸收到缓冲区时长内的尖峰）。直通模式把解码交给 DSP，音频硬件按
     * 自己的时钟推进，几乎不依赖应用 CPU——这正是所有主流音乐 App 的后台方案。
     *
     * 只在设备与音源格式都支持时生效（MP3/AAC/FLAC 等，Android 10 起较普遍），
     * 不支持时 Media3 自动回退普通解码（无副作用）；部分 ROM 直通实现有兼容
     * 问题可由设置项关闭。另注意：offload 会走独立的 50s 预灌缓冲，PCM 输出
     * 缓冲（见 createPlayer）只在回退路径生效。
     */
    private volatile boolean audioOffloadEnabled = true;
    /**
     * 最近一次「暂停」是谁发起的：true = 用户意图（通知栏/耳机/锁屏/UI），
     * false = 非用户（系统焦点让位、缓冲抑制等）。
     *
     * JS 被冻结时通知栏的暂停事件送不到 WebView，回前台 JS 会以「原生是
     * 暂停态且不是我暂停的」为依据判定为系统静默暂停，于是自动补播——
     * 用户明明按了暂停，回 App 歌自己响起来。这里把原生知道的原因记下来，
     * 经 getState 的 pausedByUser 交给 JS，让它只对真正的系统暂停补播。
     */
    private volatile boolean pausedByUser = false;
    private final android.os.Handler main =
        new android.os.Handler(android.os.Looper.getMainLooper());

    /* ---------------- 定时关闭 ---------------- */

    /**
     * 到点时间戳（epoch ms；0 = 未开启）。
     *
     * 倒计时必须活在原生服务里：WebView 切后台后 JS 定时器被系统冻结，
     * 页面侧 setTimeout 到点根本不会执行，而 ExoPlayer 照常出声——这就是
     * 「后台播放时定时关闭不生效」的根因。前台服务在播放期间持有唤醒锁，
     * main Handler 照常走，到点在原生暂停即可，不依赖页面存活。
     */
    private long sleepDeadlineMs = 0L;
    /** 到点后等当前这首播完再停（Media3 的 pauseAtEndOfMediaItems） */
    private boolean sleepCloseAfterTrack = false;
    /** 已在等当前曲播完（暂停由片尾的 END_OF_MEDIA_ITEM 触发） */
    private boolean sleepAwaitingTrackEnd = false;
    /** 淡出起始音量（暂停后还原，下次播放回到用户设定值；<0 表示没有进行中的淡出） */
    private float sleepFadeStartVolume = -1f;
    private long sleepFadeStartedAt = 0L;
    private static final long SLEEP_FADE_MS = 2000L;
    private static final long SLEEP_FADE_TICK_MS = 100L;
    /**
     * 定时关闭把播放器停在了片尾（STATE_ENDED）：吞掉这次 ended 事件，
     * 否则页面 JS 的换歌链路会把歌重新放起来（队尾 repeat off 时最典型）。
     * 任何一次重新开播都会清掉它。
     */
    private boolean sleepSuppressEnded = false;
    /**
     * 定时关闭已经停过播放：在用户显式重新开播之前，任何自动恢复链路
     * （坏源自愈的 setPlayWhenReady(true)、回前台补播的判据）都不许把歌拉回来。
     * 用户按播放 / 通知栏播放 / JS 侧 resume 都会清掉它。
     */
    private volatile boolean sleepPausedAfterTimer = false;

    /**
     * 倒计时心跳：每秒对一次**墙上时钟**再决定下一次唤醒间隔。
     * 不用一次性 postDelayed(剩余毫秒)——它基于 uptimeMillis，设备深睡时
     * 不推进，睡醒后会一次性晚到（定时关闭拖后甚至不触发）。
     */
    private final Runnable sleepTimerTick = new Runnable() {
        @Override
        public void run() {
            if (sleepDeadlineMs <= 0) {
                return;
            }
            long remaining = sleepDeadlineMs - System.currentTimeMillis();
            if (remaining <= 0) {
                onSleepTimerReached();
                return;
            }
            main.postDelayed(this, Math.min(remaining, 1000L));
        }
    };

    /** 淡出：每 100ms 降一次音量，2s 降到 0 后暂停 */
    private final Runnable sleepFadeTick = new Runnable() {
        @Override
        public void run() {
            if (player == null) {
                finishSleepTimer();
                return;
            }
            if (!player.getPlayWhenReady()) {
                // 淡出途中用户手动暂停/换歌：恢复音量，本次定时作废（与页面侧旧行为一致）
                cancelSleepFade(true);
                sleepDeadlineMs = 0L;
                sleepAwaitingTrackEnd = false;
                emitSleepTimerEvent();
                return;
            }
            float t = Math.min(
                (System.currentTimeMillis() - sleepFadeStartedAt) / (float) SLEEP_FADE_MS, 1f);
            player.setVolume(sleepFadeStartVolume * (1f - t));
            if (t >= 1f) {
                finishSleepTimer();
            } else {
                main.postDelayed(this, SLEEP_FADE_TICK_MS);
            }
        }
    };

    /** 进度心跳：播放中每秒向 JS 推 timeupdate（对齐 HTMLAudioElement 节奏） */
    private static final long PROGRESS_INTERVAL_MS = 1000L;
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            if (player == null) {
                return;
            }
            if (player.isPlaying()) {
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
    /**
     * 播放位置定期落盘：进程被系统静默回收时来不及走 onDestroy 的落盘，
     * 没有这条的话恢复出来的是「上一次队列变动时」的位置（可能差整首歌）。
     * 30s 一次足够——恢复位置的精度要求不高，省电优先。
     */
    private static final long PROGRESS_PERSIST_INTERVAL_MS = 30_000L;
    private final Runnable persistProgressTick = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                scheduleQueuePersist();
                main.postDelayed(this, PROGRESS_PERSIST_INTERVAL_MS);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        PlaybackBridge.activeService = this;
        queueStateFile = new File(getFilesDir(), QUEUE_STATE_FILE);
        player = createPlayer();
        // session activity：通知栏媒体卡片的**点击目标**。
        // 不设它 Media3 的通知缺少 contentIntent，部分 ROM（实测 realme/ColorOS）
        // 会把这条通知视为不完整而不展示——前台服务没有可见通知时会被厂商省电
        // 策略当作后台服务清理（exit-info 里的 o-kill），表现为「播一会儿就停」。
        PendingIntent sessionActivity = null;
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                sessionActivity = PendingIntent.getActivity(
                    this,
                    0,
                    launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            }
        } catch (Throwable t) {
            Log.w(TAG, "构建 sessionActivity 失败（通知点击将无反应）：" + t);
        }
        MediaSession.Builder sessionBuilder =
            new MediaSession.Builder(this, player)
            .setCallback(new MediaSession.Callback() {
                @Override
                public ListenableFuture<MediaSession.MediaItemsWithStartPosition>
                    onPlaybackResumption(MediaSession session,
                                         MediaSession.ControllerInfo controller) {
                    // 系统媒体恢复（手机重启 / 进程被杀后，用户从系统媒体卡片点播放）：
                    // 把上次落盘的队列交回去，由系统按 resume 语义开播
                    Log.i(TAG, "系统请求媒体恢复（onPlaybackResumption）");
                    return buildResumptionFuture();
                }

                @Override
                public ListenableFuture<List<MediaItem>> onAddMediaItems(
                    MediaSession session,
                    MediaSession.ControllerInfo controller,
                    List<MediaItem> mediaItems) {
                    // 外部控制器（车机 / 手表 / 助手）推来的 MediaItem 通常只带 URI，
                    // 缺 mediaId 时按 URI 补一个——播放器列表按 mediaId 对齐队列语义
                    ArrayList<MediaItem> out = new ArrayList<>();
                    for (MediaItem item : mediaItems) {
                        if (item.mediaId == null || item.mediaId.isEmpty()) {
                            String uri = item.localConfiguration != null
                                && item.localConfiguration.uri != null
                                ? item.localConfiguration.uri.toString()
                                : "";
                            out.add(uri.isEmpty() ? item
                                : item.buildUpon().setMediaId(uri).build());
                        } else {
                            out.add(item);
                        }
                    }
                    return com.google.common.util.concurrent.Futures.immediateFuture(out);
                }
            });
        // 系统媒体卡片（下拉通知栏 / 锁屏）的封面加载：本地封面是 Capacitor 的
        // WebView 专用地址，Media3 默认加载器取不到 → 换成能直读文件的实现
        sessionBuilder.setBitmapLoader(new NotificationArtworkLoader(this));
        if (sessionActivity != null) {
            sessionBuilder.setSessionActivity(sessionActivity);
        }
        mediaSession = sessionBuilder.build();
        // 队列快照恢复：进程被杀/服务重建后把上次的队列挂回来（不自动开播）
        restoreQueueState();
        player.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                // 整队都在播放器里：**不摘条目**（旧实现在这里维持「最近 2 首 + 窗口」，
                // 因为列表里只有窗口所以必须摘；现在列表就是队列本身，摘了会丢歌）
                consecutiveErrors = 0;
                scheduleQueuePersist();
                emitPlaybackEvent("itemtransition", currentMediaId(),
                    String.valueOf(player.getCurrentMediaItemIndex()));
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitPlaybackEvent(isPlaying ? "playing" : "pause", currentMediaId(), null);
                if (isPlaying) {
                    consecutiveErrors = 0;
                    // 真的播出来了：这条的失败/重试记录可以清了
                    String id = currentMediaId();
                    if (!id.isEmpty()) {
                        resolveRetries.remove(id);
                        failedSrcByMediaId.remove(id);
                    }
                    main.removeCallbacks(progressTick);
                    main.postDelayed(progressTick, PROGRESS_INTERVAL_MS);
                    main.removeCallbacks(persistProgressTick);
                    main.postDelayed(persistProgressTick, PROGRESS_PERSIST_INTERVAL_MS);
                } else {
                    main.removeCallbacks(progressTick);
                    main.removeCallbacks(persistProgressTick);
                    // 暂停即落盘一次：暂停态被杀是最常见的场景（用户放着歌去睡了）
                    persistQueueNow();
                }
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                // 播放态翻转（含焦点让位导致的暂停）：转成 play/pause 事件给 JS。
                // onIsPlayingChanged 不覆盖「缓冲中暂停/恢复」的边缘。
                // 记下暂停的发起方：通知栏/耳机/锁屏/UI 发起的都是 USER_REQUEST，
                // 系统焦点让位、suppressed 属于非用户意图（回前台可补播）。
                if (!playWhenReady) {
                    pausedByUser =
                        reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST;
                    // 「播完再关」的收尾：片尾暂停由我们主动挂上，暂停即完成定时关闭。
                    // 用户在片尾前自己暂停不算完成（恢复播放后仍要在曲末停），
                    // 与页面侧旧实现「挂 PlayEnd 等歌播完」的语义一致。
                    if (sleepAwaitingTrackEnd
                        && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) {
                        sleepAwaitingTrackEnd = false;
                        sleepCloseAfterTrack = false;
                        sleepDeadlineMs = 0L;
                        sleepSuppressEnded = true;
                        sleepPausedAfterTimer = true;
                        main.removeCallbacks(sleepTimerTick);
                        main.removeCallbacks(sleepFadeTick);
                        setPauseAtTrackEnd(false);
                        // 这不是用户按的暂停，但必须当成用户意图上报：否则回前台
                        // 对账会把这次暂停当作系统静默暂停而自动补播
                        pausedByUser = true;
                        emitSleepTimerEvent();
                        Log.i(TAG, "定时关闭已执行：当前曲播完，播放暂停");
                    }
                } else {
                    pausedByUser = false;
                    // 用户重新开播：定时关闭已经结束，别再吞下一次 ended
                    sleepSuppressEnded = false;
                    // 这是用户意图（UI / 通知栏 / 耳机 / 系统媒体键都会走到这里）：
                    // 定时关闭之后的自愈「不许自动开播」也随之解除
                    sleepPausedAfterTimer = false;
                }
                emitPlaybackEvent(playWhenReady ? "play" : "pause", currentMediaId(), null);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                // 欠载哨兵：曾在出声、播放头推进中回到 BUFFERING = 真实卡顿
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
                    emitPlaybackData(
                        "durationchange",
                        currentMediaId(),
                        "{\"durationMs\":" + player.getDuration() + "}"
                    );
                }
                if (playbackState == Player.STATE_ENDED) {
                    // 整队播尽（ExoPlayer 的 ENDED 只在「没有下一首可播」时出现，
                    // 队列内前进由它自己完成）：翻暂停态，通知栏显示播放键
                    player.seekTo(0);
                    player.setPlayWhenReady(false);
                    // 定时关闭刚好把这最后一首停在片尾：这次 ended 不再上报，
                    // 否则页面 JS 的换歌链路（onEnded → skipToNext）会把歌重新放起来
                    if (sleepSuppressEnded) {
                        sleepSuppressEnded = false;
                        return;
                    }
                    emitPlaybackEvent("ended", currentMediaId(), null);
                }
            }

            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                // 队列自愈：坏条目（直链过期/解析失败）不让整条队列停下——
                // JS 冻结时 error 事件无人处理，若停在坏条目上就是「后台播几首
                // 后自动暂停」的最终形态。
                //
                // 换源重试的实现很直接：惰性数据源是按需解析的，把这条的
                // 「已解析直链」清掉再重新 prepare，它就会重新跑一次插件
                // 拿新直链（excludeUrl 用刚失败的直链）。重试次数用尽才跳歌；
                // 连续多首全失败才真正放弃（整队坏源时避免静默空转烧电）。
                //
                // 定时关闭已经执行过（sleepPausedAfterTimer）：自愈不能替用户
                // 开播——坏源重试里的 setPlayWhenReady(true) 会把定时关掉的
                // 播放重新拉起来，这才是「定时了却还在响」的真实原因。
                if (sleepPausedAfterTimer) {
                    Log.i(TAG, "定时关闭后取流失败：只换源不自动开播（" + currentMediaId() + "）");
                    resolveRetries.remove(currentMediaId());
                    resolvedSrcByMediaId.remove(currentMediaId());
                    player.prepare();
                    emitPlaybackEvent("error", currentMediaId(),
                        (error == null ? "unknown" : String.valueOf(error.errorCode)));
                    return;
                }
                String failedId = currentMediaId();
                String failedSrc = currentSrc();
                if (!failedId.isEmpty() && !failedSrc.isEmpty()) {
                    failedSrcByMediaId.put(failedId, failedSrc);
                }
                int attempts = failedId.isEmpty() ? 0
                    : (resolveRetries.get(failedId) == null ? 0 : resolveRetries.get(failedId));

                boolean retrying = false;
                if (!failedId.isEmpty() && attempts < MAX_RESOLVE_RETRIES) {
                    // 原地换源：清缓存 → 重新 prepare → 惰性源会重新解析
                    resolveRetries.put(failedId, attempts + 1);
                    resolvedSrcByMediaId.remove(failedId);
                    Log.i(TAG, "取流失败，原地换源重试：" + failedId
                        + "（第" + (attempts + 1) + "次，"
                        + (failedSrc.isEmpty() ? "无排除地址" : "排除刚失败的直链") + "）");
                    player.prepare();
                    player.setPlayWhenReady(true);
                    retrying = true;
                }

                boolean recovered = retrying;
                if (!retrying) {
                    int index = player.getCurrentMediaItemIndex();
                    if (index + 1 < player.getMediaItemCount()
                        || player.getRepeatMode() != Player.REPEAT_MODE_OFF) {
                        // ERROR 态下播放器已停止：seek + prepare 后必须重新声明
                        // playWhenReady=true 才会真正续播（prepare 不继承播放意图）
                        player.seekToNextMediaItem();
                        player.prepare();
                        player.setPlayWhenReady(true);
                        recovered = true;
                    }
                }
                if (recovered && !retrying) {
                    consecutiveErrors += 1;
                }
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    recovered = false;
                    consecutiveErrors = 0;
                    player.setPlayWhenReady(false);
                }
                emitPlaybackEvent(
                    "error",
                    failedId,
                    (error == null ? "unknown" : String.valueOf(error.errorCode))
                        + (recovered && !retrying ? "|skip" : "")
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
        // 解析拿到的插件请求头（Referer/Cookie/自定义 UA）按播放地址注入：
        // ResolvingDataSource 在 open 前改写 DataSpec，httpRequestHeaders 会被
        // HttpDataSource 原样带上（JS 补的源行为与旧版一致）
        ResolvingDataSource.Factory headerInjectingFactory = new ResolvingDataSource.Factory(
            httpFactory,
            new ResolvingDataSource.Resolver() {
                @Override
                public androidx.media3.datasource.DataSpec resolveDataSpec(
                    androidx.media3.datasource.DataSpec dataSpec) {
                    HashMap<String, String> extra =
                        headersByUri.get(dataSpec.uri.toString());
                    if (extra != null && !extra.isEmpty()) {
                        HashMap<String, String> merged =
                            new HashMap<>(dataSpec.httpRequestHeaders);
                        merged.putAll(extra);
                        dataSpec = dataSpec.buildUpon()
                            .setHttpRequestHeaders(merged)
                            .build();
                    }
                    return dataSpec;
                }
            });
        DataSource.Factory baseFactory =
            new DefaultDataSource.Factory(this, headerInjectingFactory);
        // 惰性解析：mfhy://<mediaId> 占位条目在这里换成真实直链
        DataSource.Factory lazyFactory = () -> new LazyAudioDataSource(
            baseFactory.createDataSource(),
            this::resolveForPlayback);

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

        // 音频输出缓冲 1~2s（平台默认约 20~100ms，Media3 默认下限 250ms/上限
        // 750ms）：这是**回退路径**（音源不支持直通时）抗 CPU 调度尖峰的主力——
        // 其他应用冷启动抢占 CPU/IO、音频线程短暂饿死时，AudioTrack 靠存量数据
        // 顶着继续出声。1s 余量足够覆盖绝大多数冷启动尖峰，2s 上限留足余量。
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
                                .setMinPcmBufferDurationUs(1_000_000) // 下限 1s（微秒）
                                .setMaxPcmBufferDurationUs(2_000_000) // 上限 2s
                                .build())
                        .build();
                }
            };

        ExoPlayer p = new ExoPlayer.Builder(this)
            .setRenderersFactory(renderersFactory)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(lazyFactory))
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
        // 音频硬件直通：默认偏好开关见字段注释。TrackSelectionParameters 只能经
        // Player.setTrackSelectionParameters 下发（ExoPlayer.Builder 没有对应入口）。
        applyAudioOffload(p);
        p.addAudioOffloadListener(new ExoPlayer.AudioOffloadListener() {
            @Override
            public void onOffloadedPlayback(boolean isOffloaded) {
                Log.i(TAG, "音频直通(offload)：" + (isOffloaded ? "已启用（DSP 解码）" : "未启用/回退"));
            }
        });
        return p;
    }

    /**
     * 把硬件直通偏好下发给轨道选择器。offload 只在「设备支持该格式 + 单音轨」
     * 时生效，不支持则选普通轨自动回退，不会导致播不出声。
     * gapless/倍速要求都设为 false：本应用音源多为单曲流，且倍速为低频功能——
     * 要求满足会大幅收窄可用直通的机型；用户改倍速时 Media3 会自动回退普通解码。
     */
    private void applyAudioOffload(ExoPlayer p) {
        TrackSelectionParameters.AudioOffloadPreferences prefs =
            new TrackSelectionParameters.AudioOffloadPreferences.Builder()
                .setAudioOffloadMode(audioOffloadEnabled
                    ? TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED
                    : TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_DISABLED)
                .setIsGaplessSupportRequired(false)
                .setIsSpeedChangeSupportRequired(false)
                .build();
        p.setTrackSelectionParameters(
            new TrackSelectionParameters.Builder(this)
                .setAudioOffloadPreferences(prefs)
                .build());
    }

    /** 设置页「硬件音频直通」开关（默认开）：改完即时生效，无需重装载 */
    void setAudioOffloadEnabled(boolean enabled) {
        audioOffloadEnabled = enabled;
        runOnMain(() -> {
            if (player != null) {
                applyAudioOffload(player);
                Log.i(TAG, "音频直通(offload)偏好更新：" + (enabled ? "开启" : "关闭"));
            }
        });
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
        main.removeCallbacks(persistProgressTick);
        main.removeCallbacks(persistQueueTick);
        // 退出前落一次盘（此时 player 还活着，能读到真实进度）。
        // 注意：这里**不**清空快照——服务因系统回收而销毁时，下一次启动
        // 要靠它把队列恢复出来；用户主动停止（stop()）时才删文件
        writeQueueState();
        resolveExecutor.shutdownNow();
        persistExecutor.shutdown();
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

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    // ---------- 线程规则 ----------

    void runOnMain(java.util.concurrent.ExecutorService unused, Runnable r) {
        runOnMain(r);
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

    // ---------- 惰性解析（ExoPlayer 加载线程调用） ----------

    /**
     * 把一个 mediaId 解析成可播地址。在 ExoPlayer 的加载线程上被
     * {@link LazyAudioDataSource} 调用（预缓冲到该条目时），因此解析时机
     * 天然贴近播放——直链不会在队列里躺到过期。
     *
     * 顺序：JS 给的 src（本地文件/缓存）→ 已解析缓存 → QuickJS 跑插件。
     * 失败抛 IOException，ExoPlayer 按该条目播放错误处理，触发跳歌自愈。
     */
    private LazyAudioDataSource.Resolved resolveForPlayback(String mediaId) throws IOException {
        if (mediaId == null || mediaId.isEmpty()) {
            throw new IOException("空 mediaId");
        }
        Planned planned = plannedById.get(mediaId);
        if (planned == null) {
            throw new IOException("队列里没有这条：" + mediaId);
        }
        // JS 已给地址（本地文件 / 缓存命中 / 已解析直链）：直接用
        if (planned.src != null && !planned.src.isEmpty()) {
            recordResolved(mediaId, planned.src);
            return new LazyAudioDataSource.Resolved(
                planned.src, headersByUri.get(planned.src));
        }
        // 解析缓存命中：复用（失败时会被清掉，见 onPlayerError）
        String cached = resolvedSrcByMediaId.get(mediaId);
        if (cached != null && !cached.isEmpty()) {
            recordResolved(mediaId, cached);
            return new LazyAudioDataSource.Resolved(cached, headersByUri.get(cached));
        }
        if (planned.payload.isEmpty()) {
            throw new IOException("这条没有可解析的曲目快照（" + mediaId + "）");
        }
        String quality = planned.quality == null || planned.quality.isEmpty()
            ? "standard"
            : planned.quality;
        String excludeUrl = failedSrcByMediaId.get(mediaId) == null
            ? ""
            : failedSrcByMediaId.get(mediaId);
        Log.i(TAG, "惰性解析发起：" + mediaId
            + (excludeUrl.isEmpty() ? "" : "（排除刚失败的直链）"));
        String resultJson = null;
        try {
            resultJson = PluginRuntime.getInstance(getApplicationContext())
                .resolve(planned.payload, quality, excludeUrl, RESOLVE_TIMEOUT_MS);
        } catch (Throwable t) {
            throw new IOException("解析异常：" + t.getMessage(), t);
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
            Log.i(TAG, "惰性解析失败：" + mediaId);
            throw new IOException("音源解析失败：" + mediaId);
        }
        Log.i(TAG, "惰性解析成功：" + mediaId);
        rememberHeadersFor(url, resultJson);
        resolvedSrcByMediaId.put(mediaId, url);
        recordResolved(mediaId, url);
        return new LazyAudioDataSource.Resolved(url, headersByUri.get(url));
    }

    /** 记下「这个 mediaId 当前用的是哪个地址」（getState/currentSrc 供对账用） */
    private void recordResolved(String mediaId, String src) {
        if (mediaId == null || mediaId.isEmpty() || src == null || src.isEmpty()) {
            return;
        }
        sSrcById.put(mediaId, src);
    }

    /** 记住插件返回的请求头（按播放地址索引），数据源 open 时按 URI 注入 */
    private void rememberHeadersFor(String url, String resultJson) {
        try {
            JSONObject res = new JSONObject(resultJson);
            HashMap<String, String> map = new HashMap<>();
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
            while (headersByUri.size() > 128) {
                java.util.Iterator<String> first = headersByUri.keySet().iterator();
                first.next();
                first.remove();
            }
        } catch (Exception ignored) {
        }
    }

    // ---------- 队列装配（JS 遥控器 → 原生播放器） ----------

    /**
     * 整条队列入档：items 按**播放顺序**排列（JS 侧队列语义的产物），
     * 每条的 src 可空（空 = 交给惰性解析）。当前曲若在新队列里，播放不打断
     * （只换掉它之后的列表），否则从队首（或指定 currentMediaId）开始。
     *
     * `shuffle`/`repeat` 由 JS 侧的用户设置而来：shuffle=true 时原生用
     * ShuffleOrder 打乱推进顺序；repeat=single 时单曲循环、queue 时整队循环。
     */
    void setQueue(List<Planned> items, String currentMediaId, boolean shuffle, String mode) {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            if (items == null || items.isEmpty()) {
                player.stop();
                player.clearMediaItems();
                plannedById.evictAll();
                resolvedSrcByMediaId.clear();
                failedSrcByMediaId.clear();
                resolveRetries.clear();
                sSrcById.evictAll();
                scheduleQueuePersist();
                return;
            }
            int size = Math.min(items.size(), MAX_QUEUE_SIZE);
            ArrayList<MediaItem> mediaItems = new ArrayList<>(size);
            for (int i = 0; i < size; i++) {
                Planned p = items.get(i);
                if (p == null || p.mediaId == null || p.mediaId.isEmpty()) {
                    continue;
                }
                plannedById.put(p.mediaId, p);
                // 已有 src 的直接用真实地址；缺源的挂占位 URI 交给惰性解析
                String uri = (p.src != null && !p.src.isEmpty())
                    ? normalizeSrc(p.src)
                    : placeholderUri(p.mediaId);
                if (p.src != null && !p.src.isEmpty()) {
                    recordResolved(p.mediaId, p.src);
                }
                mediaItems.add(buildItem(uri, p));
            }
            if (mediaItems.isEmpty()) {
                return;
            }
            applyOrderMode(shuffle, mode);

            String current = currentMediaId == null ? "" : currentMediaId;
            String nativeCurrent = currentMediaId();
            // 幂等 guard：JS 的 playing/对账路径会重复推送完全相同的队列，
            // setMediaItems 即使内容不变也会 reset 播放器（pause→playing 拉锯，
            // 前台有 JS 存活时复现、后台冻结时自愈）。列表一致时只做增量替换。
            if (isSamePlaylist(mediaItems)) {
                int currentIndex = player.getCurrentMediaItemIndex();
                for (int i = 0; i < mediaItems.size() && i < player.getMediaItemCount(); i++) {
                    MediaItem cur = player.getMediaItemAt(i);
                    MediaItem next = mediaItems.get(i);
                    String curUri = cur != null && cur.localConfiguration != null
                        && cur.localConfiguration.uri != null
                        ? cur.localConfiguration.uri.toString() : "";
                    String nextUri = next.localConfiguration != null
                        && next.localConfiguration.uri != null
                        ? next.localConfiguration.uri.toString() : "";
                    boolean uriChanged = !curUri.equals(nextUri);
                    if (i == currentIndex && uriChanged) {
                        // 正在播的条目不能换地址：replaceMediaItem 会把它的数据源
                        // 换掉、缓冲区作废，播放中表现为从头重解析/重播。
                        // 只改元数据（封面/标题）的替换 Media3 会走 canUpdateMediaItem
                        // 就地更新，不重建数据源，所以那种替换放行——本地音乐匹配到
                        // 封面后，系统媒体卡片就是靠它换图的。
                        continue;
                    }
                    if (uriChanged || !sameMediaMetadata(cur, next)) {
                        player.replaceMediaItem(i, next);
                    }
                }
                // **setQueue 只是队列刷新，不是"换在这首播"的指令**：播放器已有
                // 有效的当前条目时，以它为准，绝不因为 JS 传了另一个 currentMediaId
                // 就 seek 过去。JS 长时间后台被冻结后并不知播放器已经自行续播到
                // 第几首，回前台若先推一次队列，就会拿冻结前的旧当前曲把播放器
                // 拽回那首——本 bug 的主路径（对齐后 JS 自己会把 current 修正）。
                if (nativeCurrent.isEmpty() && !current.isEmpty()) {
                    // 播放器还没有当前条目（服务重建后的恢复态）：按 JS 的 current 定位
                    int targetSame = indexOfMediaId(current);
                    if (targetSame >= 0) {
                        player.seekTo(targetSame, 0L);
                        player.prepare();
                    }
                }
                scheduleQueuePersist();
                return;
            }
            // 锚点：原生当前曲（它在新列表里时）优先，其次 JS 的 current，最后队首。
            String anchor = "";
            if (!nativeCurrent.isEmpty() && containsMediaId(mediaItems, nativeCurrent)) {
                anchor = nativeCurrent;
            } else if (!current.isEmpty() && containsMediaId(mediaItems, current)) {
                anchor = current;
            }
            int existingIndex = indexOfMediaId(nativeCurrent);
            int target = 0;
            if (!anchor.isEmpty()) {
                for (int i = 0; i < mediaItems.size(); i++) {
                    if (anchor.equals(mediaItems.get(i).mediaId)) {
                        target = i;
                        break;
                    }
                }
            }
            boolean keepPlaying = existingIndex >= 0
                && anchor.equals(nativeCurrent)
                && player.getPlaybackState() != Player.STATE_IDLE;
            if (keepPlaying) {
                // 当前曲没变：把新列表定位到该曲在**新列表**中的位置（target），
                // 保留播放位置与播放意图。注意不能用 existingIndex——它是旧播放器
                // 列表里的下标（如 loadTrack 后的单条列表里恒为 0），用它会跳回第一首。
                long pos = player.getCurrentPosition();
                boolean wasPlaying = player.getPlayWhenReady();
                player.setMediaItems(mediaItems, target, pos);
                player.setPlayWhenReady(wasPlaying);
            } else {
                boolean wasPlaying = player.getPlayWhenReady();
                player.setMediaItems(mediaItems, target, 0L);
                player.prepare();
                // 只延续原有的播放意图：队列换血不替用户开播（旧实现在 current
                // 非空时强制 true，回前台拿陈旧 current 推队列就会"自动播放"）
                player.setPlayWhenReady(wasPlaying);
            }
            scheduleQueuePersist();
        });
    }

    /** 单曲装载（兼容 JS 的「新起一首」路径）：整队替换为这一首 */
    void loadTrack(String src, String mediaId, long startMs, boolean autoplay,
                   String title, String artist, String album, String artworkUri,
                   String payload, String quality) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()) {
                return;
            }
            Planned planned = new Planned(mediaId, src, title, artist, album,
                artworkUri, payload, quality);
            plannedById.put(mediaId, planned);
            resolvedSrcByMediaId.remove(mediaId);
            failedSrcByMediaId.remove(mediaId);
            resolveRetries.remove(mediaId);
            String uri = (src != null && !src.isEmpty())
                ? normalizeSrc(src)
                : placeholderUri(mediaId);
            if (src != null && !src.isEmpty()) {
                recordResolved(mediaId, src);
            }
            if (src == null || src.isEmpty()) {
                // 无源：挂在占位 URI 上，等惰性解析（JS 随后可能补源/推队列）
                player.setMediaItem(buildItem(uri, planned), 0L);
            } else {
                player.setMediaItem(buildItem(uri, planned), Math.max(startMs, 0L));
            }
            player.prepare();
            player.setPlayWhenReady(autoplay);
            scheduleQueuePersist();
        });
    }

    /** 补一条已解析音源（JS 侧缓存落盘本地化 / 主动补源）：就地替换条目地址 */
    void supplySource(String mediaId, String src) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()
                || src == null || src.isEmpty()) {
                return;
            }
            Planned planned = plannedById.get(mediaId);
            if (planned != null) {
                planned.src = src;
            }
            resolvedSrcByMediaId.put(mediaId, src);
            failedSrcByMediaId.remove(mediaId);
            recordResolved(mediaId, src);
            for (int i = 0; i < player.getMediaItemCount(); i++) {
                MediaItem it = player.getMediaItemAt(i);
                if (it != null && mediaId.equals(it.mediaId)) {
                    player.replaceMediaItem(i,
                        it.buildUpon().setUri(normalizeSrc(src)).build());
                    break;
                }
            }
            scheduleQueuePersist();
        });
    }

    /**
     * 就地刷新一条队列条目的展示元数据：本地音乐在播放页匹配到封面 / 歌词后，
     * JS 把新的封面地址推过来，系统媒体卡片（下拉通知栏 / 锁屏）立刻换图。
     *
     * 只换元数据、**不动音频地址**：Media3 对「URI 不变、只有元数据变化」的
     * replaceMediaItem 走 {@code canUpdateMediaItem} 的就地更新（不重建数据源、
     * 不作废缓冲、播放位置与出声都不断），元数据变化本身也会触发通知卡片重绘。
     *
     * 这条不在原生队列里时不做事：JS 下次推整条队列时自然带上新元数据。
     */
    void updateItemMeta(String mediaId, String title, String artist, String album,
                        String artworkUri) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()) {
                return;
            }
            Planned old = plannedById.get(mediaId);
            if (old == null) {
                return;
            }
            // 计划条目一起换新：之后的队列重推 / 队列快照恢复不会退回旧封面
            Planned fresh = new Planned(
                mediaId,
                old.src,
                pickMeta(title, old.title),
                pickMeta(artist, old.artist),
                pickMeta(album, old.album),
                pickMeta(artworkUri, old.artworkUri),
                old.payload,
                old.quality);
            plannedById.put(mediaId, fresh);
            int index = indexOfMediaId(mediaId);
            if (index < 0) {
                scheduleQueuePersist();
                return;
            }
            MediaItem cur = player.getMediaItemAt(index);
            String uri = cur != null && cur.localConfiguration != null
                && cur.localConfiguration.uri != null
                ? cur.localConfiguration.uri.toString() : "";
            if (uri.isEmpty()) {
                return;
            }
            // 用条目**当前**的 URI 重建（地址原样保留 → Media3 走就地更新），只换元数据
            player.replaceMediaItem(index, buildItem(uri, fresh));
            scheduleQueuePersist();
            refreshNotification();
        });
    }

    /** 新值非空就用新值，否则保留旧值（JS 没给的字段不该被清空） */
    private static String pickMeta(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    /**
     * 通知卡片的元数据是否一致（标题 / 歌手 / 专辑 / 封面地址）。
     * setQueue 的增量替换要在「只有元数据变了」时也更新条目——本地音乐匹配到
     * 封面后队列里那些还没播到的歌也要跟着换图。
     */
    private static boolean sameMediaMetadata(@Nullable MediaItem a, @Nullable MediaItem b) {
        if (a == null || b == null) {
            return a == b;
        }
        MediaMetadata ma = a.mediaMetadata;
        MediaMetadata mb = b.mediaMetadata;
        return eq(ma.title, mb.title)
            && eq(ma.artist, mb.artist)
            && eq(ma.albumTitle, mb.albumTitle)
            && sameUri(ma.artworkUri, mb.artworkUri);
    }

    private static boolean eq(@Nullable CharSequence a, @Nullable CharSequence b) {
        return a == null ? b == null : a.equals(b);
    }

    private static boolean sameUri(@Nullable Uri a, @Nullable Uri b) {
        return a == null ? b == null : a.equals(b);
    }

    /**
     * 让系统媒体卡片重绘一次（封面刚被覆盖成新图时用）。
     *
     * 走 MediaSessionService 公开的 {@code onUpdateNotification(session, required)}：
     * required 与 Media3 自己的判据一致（在播 / 缓冲中且 playWhenReady），
     * 免得把正在前台播放的服务误降出前台态。
     */
    private void refreshNotification() {
        MediaSession session = mediaSession;
        if (session == null || player == null) {
            return;
        }
        boolean startInForegroundRequired =
            player.getPlayWhenReady()
                && (player.getPlaybackState() == Player.STATE_READY
                    || player.getPlaybackState() == Player.STATE_BUFFERING);
        try {
            onUpdateNotification(session, startInForegroundRequired);
        } catch (Throwable t) {
            Log.w(TAG, "刷新媒体通知失败：" + t);
        }
    }

    /** 撤一条队列条目（JS 解析失败/冷却跳过） */
    void dropPlanned(String mediaId) {
        runOnMain(() -> {
            if (player == null || mediaId == null || mediaId.isEmpty()) {
                return;
            }
            for (int i = player.getMediaItemCount() - 1; i >= 0; i--) {
                MediaItem it = player.getMediaItemAt(i);
                if (it != null && mediaId.equals(it.mediaId)) {
                    player.removeMediaItems(i, i + 1);
                }
            }
            plannedById.remove(mediaId);
            resolvedSrcByMediaId.remove(mediaId);
            failedSrcByMediaId.remove(mediaId);
            resolveRetries.remove(mediaId);
            scheduleQueuePersist();
        });
    }

    // ---------- 播放控制 ----------

    void play() {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            // 队列快照恢复出来的列表是 IDLE 态（没有 prepare）：只 setPlayWhenReady
            // 不会出声，必须先 prepare
            if (player.getPlaybackState() == Player.STATE_IDLE
                && player.getMediaItemCount() > 0) {
                player.prepare();
            }
            player.setPlayWhenReady(true);
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
            plannedById.evictAll();
            resolvedSrcByMediaId.clear();
            failedSrcByMediaId.clear();
            resolveRetries.clear();
            resolveRetries.clear();
            sSrcById.evictAll();
            // 队列已清空：落盘也要清掉，否则下次启动会把「已停止」的队列恢复出来
            scheduleQueuePersist();
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
        int target = direction > 0
            ? player.getNextMediaItemIndex()
            : player.getPreviousMediaItemIndex();
        if (target == C.INDEX_UNSET || target == index) {
            return null;
        }
        player.seekTo(target, 0L);
        player.setPlayWhenReady(true);
        String mediaId = currentMediaId();
        return mediaId.isEmpty() ? null : mediaId;
    }

    /**
     * 跳到队列里的指定条目（JS 手动点播队列内的歌）：整队都在播放器列表里，
     * 直接定位 seek 即可（不再有「计划深处要先撤下前面的条目」那回事）。
     * 命中返回 mediaId，未命中返回 null（JS 回退常规换歌链路）。
     */
    String jumpToMediaItem(String mediaId) {
        if (player == null || mediaId == null || mediaId.isEmpty()
            || android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            return null;
        }
        int index = indexOfMediaId(mediaId);
        if (index < 0) {
            return null;
        }
        if (index == player.getCurrentMediaItemIndex() && player.getPlaybackState() != Player.STATE_IDLE) {
            return null;
        }
        player.seekTo(index, 0L);
        player.prepare();
        player.setPlayWhenReady(true);
        scheduleQueuePersist();
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

    /**
     * 播放顺序（v1.0.15 归原生）：
     *  - mode "off"    → 顺序播放，到队尾停（REPEAT_MODE_OFF）
     *  - mode "queue"  → 随机播放（UI 图标即 shuffle）：ShuffleOrder + 整队循环
     *  - mode "single" → 单曲循环（REPEAT_MODE_ONE）
     * shuffle 与 mode 分开传：JS 的随机是「queue」这一档，但原生侧它由
     * ShuffleOrder 实现，与之正交的是 repeat 模式本身。
     */
    void setPlaybackOrder(boolean shuffle, String mode) {
        runOnMain(() -> applyOrderMode(shuffle, mode));
    }

    private void applyOrderMode(boolean shuffle, String mode) {
        if (player == null) {
            return;
        }
        String m = mode == null || mode.isEmpty() ? "off" : mode;
        int repeat;
        if ("single".equals(m)) {
            repeat = Player.REPEAT_MODE_ONE;
        } else if ("queue".equals(m)) {
            // 随机播放：整队循环，配合下面的 ShuffleOrder 走遍队列
            repeat = Player.REPEAT_MODE_ALL;
        } else {
            repeat = Player.REPEAT_MODE_OFF;
        }
        player.setRepeatMode(repeat);
        // shuffle=false 时给出确定性的顺序（用 null 恢复列表原序）
        if (shuffle) {
            player.setShuffleOrder(new ShuffleOrder.DefaultShuffleOrder(
                Math.max(player.getMediaItemCount(), 0), System.nanoTime()));
            player.setShuffleModeEnabled(true);
        } else {
            player.setShuffleModeEnabled(false);
        }
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

    // ---------- 定时关闭（倒计时在原生，页面冻结也照常生效） ----------

    /**
     * 设置 / 取消定时关闭。deadlineMs 语义：
     *  - > 0：到点时间戳（epoch ms），重设定时；
     *  - = 0：取消定时；
     *  - < 0：**只改「播完再关」开关**，不动已设定的倒计时（到点后仍在等
     *    片尾时用户改勾选走这条，取消勾选就当场停）。
     *
     * closeAfterTrack = true 时到点不立刻停，而是挂 Media3 的
     * pauseAtEndOfMediaItems：当前这首放完由播放器自己暂停
     * （PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM）。
     */
    @OptIn(markerClass = UnstableApi.class)
    void setSleepTimer(long deadlineMs, boolean closeAfterTrack) {
        runOnMain(() -> {
            if (deadlineMs < 0) {
                // 只改开关：倒计时/等待片尾的现状都不动
                sleepCloseAfterTrack = closeAfterTrack;
                if (sleepAwaitingTrackEnd && !closeAfterTrack) {
                    // 到点后已在等片尾，用户又取消了勾选：立刻停（与页面侧旧行为一致）
                    finishSleepTimer();
                } else {
                    emitSleepTimerEvent();
                }
                return;
            }
            main.removeCallbacks(sleepTimerTick);
            main.removeCallbacks(sleepFadeTick);
            // 上一次的淡出没走完就改了定时：先把音量还原
            cancelSleepFade(true);
            sleepAwaitingTrackEnd = false;
            sleepCloseAfterTrack = closeAfterTrack;
            sleepSuppressEnded = false;
            if (player != null) {
                // 单曲循环下 ExoPlayer 也停在曲末（每个 MediaItem 都是独立的
                // timeline window），正是「播完再关」要的语义
                setPauseAtTrackEnd(false);
            }
            if (deadlineMs <= 0) {
                sleepDeadlineMs = 0L;
                emitSleepTimerEvent();
                scheduleQueuePersist();
                return;
            }
            long delay = deadlineMs - System.currentTimeMillis();
            if (delay <= 0) {
                // 传了个已过期的时间戳：视同现在就关
                sleepDeadlineMs = 0L;
                onSleepTimerReached();
                return;
            }
            sleepDeadlineMs = deadlineMs;
            main.postDelayed(sleepTimerTick, Math.min(delay, 1000L));
            emitSleepTimerEvent();
            // 定时状态落盘：服务被系统回收重建后倒计时还能接上
            scheduleQueuePersist();
            Log.i(TAG, "定时关闭已设置：" + (delay / 1000) + "s 后"
                + (closeAfterTrack ? "（等当前曲播完）" : ""));
        });
    }

    /** 到点：等播完就挂片尾暂停，否则淡出后暂停 */
    private void onSleepTimerReached() {
        // 截止时间已到：倒计时结束（页面侧据此收起剩余时间显示）。
        // 「等当前曲播完」是到点之后的等待态，不靠 deadline 表达。
        sleepDeadlineMs = 0L;
        main.removeCallbacks(sleepTimerTick);
        if (player == null) {
            finishSleepTimer();
            return;
        }
        if (sleepCloseAfterTrack) {
            // 单曲循环下 ExoPlayer 也停在曲末（每个 MediaItem 都是独立的
            // timeline window），正是「播完再关」要的语义；没在播（已暂停）
            // 就当场收尾，不必等
            if (player.getPlayWhenReady()) {
                sleepAwaitingTrackEnd = true;
                setPauseAtTrackEnd(true);
                emitSleepTimerEvent();
                scheduleQueuePersist();
                Log.i(TAG, "定时关闭到点：等当前曲播完再停");
                return;
            }
            finishSleepTimer();
            return;
        }
        if (player.getPlayWhenReady()) {
            startSleepFade();
        } else {
            finishSleepTimer();
        }
    }

    /** 2 秒音量渐弱（到点即掐断显得突兀） */
    private void startSleepFade() {
        if (player == null) {
            finishSleepTimer();
            return;
        }
        float start = player.getVolume();
        if (start <= 0.01f) {
            finishSleepTimer();
            return;
        }
        sleepFadeStartVolume = start;
        sleepFadeStartedAt = System.currentTimeMillis();
        main.removeCallbacks(sleepFadeTick);
        main.postDelayed(sleepFadeTick, SLEEP_FADE_TICK_MS);
    }

    /** 中止淡出：restoreVolume=true 时把音量还原到淡出前 */
    private void cancelSleepFade(boolean restoreVolume) {
        main.removeCallbacks(sleepFadeTick);
        if (restoreVolume && sleepFadeStartVolume >= 0 && player != null) {
            player.setVolume(sleepFadeStartVolume);
        }
        sleepFadeStartVolume = -1f;
    }

    /**
     * 收尾：暂停并复位定时状态。不开 stop() —— 与页面侧实现一致，
     * 保留播放进度与队列，用户回来按播放即可续上。
     */
    private void finishSleepTimer() {
        float restoreVolume = sleepFadeStartVolume;
        cancelSleepFade(false);
        main.removeCallbacks(sleepTimerTick);
        sleepDeadlineMs = 0L;
        sleepAwaitingTrackEnd = false;
        sleepSuppressEnded = true;
        sleepPausedAfterTimer = true;
        sleepCloseAfterTrack = false;
        if (player != null) {
            setPauseAtTrackEnd(false);
            player.setPlayWhenReady(false);
            // 淡出到 0 后暂停：音量还原，下次播放回到用户设定值
            if (restoreVolume >= 0f) {
                player.setVolume(restoreVolume);
            }
        }
        emitSleepTimerEvent();
        scheduleQueuePersist();
        Log.i(TAG, "定时关闭已执行：播放暂停");
    }

    /** 当前定时状态（getState 用）：未开启时 deadline=0 */
    long sleepTimerDeadline() {
        return sleepDeadlineMs;
    }

    /**
     * 挂/撤「曲末暂停」。Media3 里这条 API 属 UnstableApi，集中在这里
     * 加注解，调用点（事件回调、淡出、收尾）就不必各自标注。
     */
    @OptIn(markerClass = UnstableApi.class)
    private void setPauseAtTrackEnd(boolean pauseAtEnd) {
        if (player != null) {
            player.setPauseAtEndOfMediaItems(pauseAtEnd);
        }
    }

    /** 定时关闭状态变更事件：页面侧据此即时同步倒计时（不依赖页面轮询） */
    private void emitSleepTimerEvent() {
        emitPlaybackData(
            "sleeptimer",
            currentMediaId(),
            "{\"sleepDeadline\":" + sleepDeadlineMs
                + ",\"sleepCloseAfterTrack\":" + (sleepCloseAfterTrack && sleepAwaitingTrackEnd) + "}"
        );
    }

    /** 定时关闭是否在等当前曲播完（getState 用） */
    boolean sleepTimerCloseAfterTrack() {
        return sleepCloseAfterTrack && sleepAwaitingTrackEnd;
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

    /** 当前暂停态是否用户发起的（getState 用：回前台据此决定要不要补播） */
    boolean isPausedByUser() {
        // 定时关闭停下的播放同样不许自动补播——哪怕 reason 判据没覆盖到
        // （比如服务重建后 pausedByUser 丢了），这条也兜得住
        return pausedByUser || sleepPausedAfterTimer;
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
        if (player.getRepeatMode() != Player.REPEAT_MODE_OFF
            || player.getShuffleModeEnabled()) {
            return player.getMediaItemCount() > 0;
        }
        return player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount();
    }

    /** 队列内当前曲之后的条目数（对账用） */
    int plannedCount() {
        if (player == null) {
            return 0;
        }
        return Math.max(0, player.getMediaItemCount() - player.getCurrentMediaItemIndex() - 1);
    }

    /** 下一首的 mediaId（JS 对账/预览用）；没有则空串 */
    String plannedHeadMediaId() {
        if (player == null) {
            return "";
        }
        int next = player.getNextMediaItemIndex();
        if (next == C.INDEX_UNSET || next < 0 || next >= player.getMediaItemCount()) {
            return "";
        }
        MediaItem it = player.getMediaItemAt(next);
        return it == null || it.mediaId == null ? "" : it.mediaId;
    }

    /**
     * 是否在「等下一条音源」：新架构下解析在加载线程内完成，
     * 不存在队列停摆等源的中间态（解析失败就跳歌），恒为 false。
     * 保留字段是给 JS 的 getState 兼容（旧对账逻辑读它）。
     */
    boolean isAwaitingSource() {
        return false;
    }

    float currentRate() {
        return player == null ? 1f : player.getPlaybackParameters().speed;
    }

    float currentVolume() {
        return player == null ? 1f : player.getVolume();
    }

    // ---------- 内部 ----------

    private int indexOfMediaId(String mediaId) {
        if (player == null || mediaId == null || mediaId.isEmpty()) {
            return -1;
        }
        for (int i = 0; i < player.getMediaItemCount(); i++) {
            MediaItem it = player.getMediaItemAt(i);
            if (it != null && mediaId.equals(it.mediaId)) {
                return i;
            }
        }
        return -1;
    }

    /** mediaId 是否在这批待装载的列表里（setQueue 锚点选择用） */
    private static boolean containsMediaId(java.util.List<MediaItem> items, String mediaId) {
        if (items == null || mediaId == null || mediaId.isEmpty()) {
            return false;
        }
        for (MediaItem it : items) {
            if (it != null && mediaId.equals(it.mediaId)) {
                return true;
            }
        }
        return false;
    }

    /** 新队列与播放器现有列表的 mediaId 顺序是否完全一致（幂等 guard 用） */
    private boolean isSamePlaylist(java.util.List<MediaItem> next) {
        if (player == null || next == null) {
            return false;
        }
        if (player.getMediaItemCount() != next.size()) {
            return false;
        }
        for (int i = 0; i < next.size(); i++) {
            MediaItem a = player.getMediaItemAt(i);
            MediaItem b = next.get(i);
            String ida = a == null ? "" : String.valueOf(a.mediaId);
            String idb = b == null ? "" : String.valueOf(b.mediaId);
            if (!ida.equals(idb)) {
                return false;
            }
        }
        return true;
    }

    /** 占位 URI：惰性解析的触发标记（ExoPlayer 预缓冲到它才去要真实直链） */
    private static String placeholderUri(String mediaId) {
        return LazyAudioDataSource.SCHEME + "://" + Uri.encode(mediaId);
    }

    /** src 归一化：capacitor 文件地址还原为 file:// 绝对路径 */
    private static String normalizeSrc(String src) {
        int fileMark = src.indexOf("/_capacitor_file_");
        if (fileMark >= 0) {
            return "file://" + src.substring(fileMark + "/_capacitor_file_".length());
        }
        return src;
    }

    private MediaItem buildItem(String uri, Planned p) {
        MediaItem.Builder builder = new MediaItem.Builder().setUri(uri);
        if (p.mediaId != null && !p.mediaId.isEmpty()) {
            builder.setMediaId(p.mediaId);
        }
        MediaMetadata.Builder meta = new MediaMetadata.Builder();
        if (p.title != null && !p.title.isEmpty()) {
            meta.setTitle(p.title);
        }
        if (p.artist != null && !p.artist.isEmpty()) {
            meta.setArtist(p.artist);
        }
        if (p.album != null && !p.album.isEmpty()) {
            meta.setAlbumTitle(p.album);
        }
        if (p.artworkUri != null && !p.artworkUri.isEmpty()) {
            // 封面地址同样要归一化：本地音乐的封面是 Capacitor 的
            // `https://localhost/_capacitor_file_/...`，只有 WebView 能拦这个域名，
            // 系统媒体卡片（Media3）直接请求会失败——还原成 file:// 才能显示
            meta.setArtworkUri(Uri.parse(normalizeSrc(p.artworkUri)));
        }
        builder.setMediaMetadata(meta.build());
        return builder.build();
    }

    // ---------- 队列持久化 ----------

    /** 队列有变动/进度推进：去抖落盘（主线程调用） */
    private void scheduleQueuePersist() {
        if (restoringQueue || queueStateFile == null) {
            return;
        }
        if (persistQueueScheduled) {
            return;
        }
        persistQueueScheduled = true;
        main.postDelayed(persistQueueTick, QUEUE_PERSIST_DEBOUNCE_MS);
    }

    /** 立即落盘一次（暂停/退出前用，绕过去抖） */
    private void persistQueueNow() {
        if (restoringQueue || queueStateFile == null) {
            return;
        }
        main.removeCallbacks(persistQueueTick);
        persistQueueScheduled = false;
        writeQueueState();
    }

    private void writeQueueState() {
        if (queueStateFile == null) {
            return;
        }
        final String json = buildQueueStateJson();
        if (json == null) {
            // 无可存内容（队列已清空 / stop）：删掉旧快照，避免下次启动
            // 把用户已经停止的队列恢复出来
            persistExecutor.execute(() -> {
                try {
                    //noinspection ResultOfMethodCallIgnored
                    queueStateFile.delete();
                } catch (Throwable ignored) {
                }
            });
            return;
        }
        persistExecutor.execute(() -> {
            FileOutputStream fos = null;
            File tmp = new File(queueStateFile.getParentFile(), QUEUE_STATE_FILE + ".tmp");
            try {
                fos = new FileOutputStream(tmp);
                fos.write(json.getBytes(StandardCharsets.UTF_8));
                fos.getFD().sync();
                fos.close();
                fos = null;
                if (!tmp.renameTo(queueStateFile)) {
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                }
            } catch (Throwable t) {
                Log.w(TAG, "队列快照落盘失败：" + t);
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            } finally {
                if (fos != null) {
                    try {
                        fos.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
        });
    }

    /** 生成队列快照 JSON（须主线程；player 访问限制）；没什么可存时返回 null */
    private String buildQueueStateJson() {
        if (player == null || player.getMediaItemCount() == 0) {
            return null;
        }
        try {
            JSONObject root = new JSONObject();
            JSONArray items = new JSONArray();
            for (int i = 0; i < player.getMediaItemCount(); i++) {
                MediaItem it = player.getMediaItemAt(i);
                if (it == null || it.mediaId == null || it.mediaId.isEmpty()) {
                    continue;
                }
                JSONObject o = new JSONObject();
                o.put("mediaId", it.mediaId);
                // 地址：优先用惰性解析缓存里的真实直链，其次列表 URI
                String resolved = resolvedSrcByMediaId.get(it.mediaId);
                String uri = resolved != null && !resolved.isEmpty()
                    ? resolved
                    : (it.localConfiguration != null && it.localConfiguration.uri != null
                        ? it.localConfiguration.uri.toString()
                        : "");
                // 占位 URI 不写进快照（恢复时按缺源处理，重新惰性解析即可）
                if (uri.startsWith(LazyAudioDataSource.SCHEME + "://")) {
                    uri = "";
                }
                o.put("src", uri);
                MediaMetadata meta = it.mediaMetadata;
                if (meta != null) {
                    o.put("title", meta.title == null ? "" : meta.title);
                    o.put("artist", meta.artist == null ? "" : meta.artist);
                    o.put("album", meta.albumTitle == null ? "" : meta.albumTitle);
                    o.put("artworkUri",
                        meta.artworkUri == null ? "" : meta.artworkUri.toString());
                }
                Planned p = plannedById.get(it.mediaId);
                if (p != null) {
                    o.put("payload", p.payload);
                    o.put("quality", p.quality);
                }
                items.put(o);
            }
            if (items.length() == 0) {
                return null;
            }
            root.put("items", items);
            root.put("currentIndex", Math.max(0, player.getCurrentMediaItemIndex()));
            root.put("positionMs", Math.max(0L, player.getCurrentPosition()));
            int rm = player.getRepeatMode();
            root.put("mode", rm == Player.REPEAT_MODE_ONE ? "single"
                : rm == Player.REPEAT_MODE_ALL ? "queue" : "off");
            root.put("shuffle", player.getShuffleModeEnabled());
            root.put("focusEnabled", focusEnabled);
            root.put("audioOffload", audioOffloadEnabled);
            // 定时关闭一并落盘：服务被系统回收重建后，倒计时还能接上
            root.put("sleepDeadline", sleepDeadlineMs);
            root.put("sleepCloseAfterTrack", sleepCloseAfterTrack);
            root.put("savedAt", System.currentTimeMillis());
            return root.toString();
        } catch (Throwable t) {
            Log.w(TAG, "生成队列快照失败：" + t);
            return null;
        }
    }

    /**
     * 冷启动恢复：把上次的队列挂回播放器。**不 prepare、不自动开播**——
     * 进程重启后的出声必须由用户发起（系统媒体恢复卡片会显示上一首，
     * 用户点播放才出声），与原生播放器语义一致。
     * 缺 src 的条目挂在占位 URI 上，播放时由惰性解析补上。
     */
    private void restoreQueueState() {
        if (player == null || queueStateFile == null || !queueStateFile.exists()) {
            return;
        }
        String raw = readQueueStateRaw();
        if (raw == null || raw.isEmpty()) {
            return;
        }
        restoringQueue = true;
        try {
            JSONObject root = new JSONObject(raw);
            JSONArray items = root.optJSONArray("items");
            if (items == null || items.length() == 0) {
                return;
            }
            ArrayList<MediaItem> mediaItems = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.optJSONObject(i);
                if (o == null) {
                    continue;
                }
                String mediaId = o.optString("mediaId", "");
                if (mediaId.isEmpty()) {
                    continue;
                }
                String src = o.optString("src", "");
                Planned p = new Planned(mediaId, src, o.optString("title", ""),
                    o.optString("artist", ""), o.optString("album", ""),
                    o.optString("artworkUri", ""), o.optString("payload", ""),
                    o.optString("quality", ""));
                plannedById.put(mediaId, p);
                String uri = src.isEmpty() ? placeholderUri(mediaId) : normalizeSrc(src);
                if (!src.isEmpty()) {
                    resolvedSrcByMediaId.put(mediaId, src);
                    recordResolved(mediaId, src);
                }
                mediaItems.add(buildItem(uri, p));
            }
            if (mediaItems.isEmpty()) {
                return;
            }
            int index = Math.max(0,
                Math.min(root.optInt("currentIndex", 0), mediaItems.size() - 1));
            player.setMediaItems(mediaItems, index, 0L);
            applyOrderMode(root.optBoolean("shuffle", false),
                root.optString("mode", "off"));
            setAudioFocusMode(root.optBoolean("focusEnabled", false));
            setAudioOffloadEnabled(root.optBoolean("audioOffload", true));
            // 定时关闭接上：服务被系统回收重建时倒计时不能丢，否则「放着歌睡
            // 着、中途服务被回收」之后定时就失效了
            long restoredDeadline = root.optLong("sleepDeadline", 0L);
            if (restoredDeadline > System.currentTimeMillis()) {
                boolean restoredCloseAfter =
                    root.optBoolean("sleepCloseAfterTrack", false);
                setSleepTimer(restoredDeadline, restoredCloseAfter);
                Log.i(TAG, "定时关闭随队列快照恢复："
                    + ((restoredDeadline - System.currentTimeMillis()) / 1000) + "s 后");
            }
            // 不 prepare、不 setPlayWhenReady：等用户按播放
            Log.i(TAG, "队列快照恢复：" + mediaItems.size() + " 首，停在索引 " + index
                + "（缺源的条目播放时再解析）");
        } catch (Throwable t) {
            Log.w(TAG, "队列快照恢复失败：" + t);
        } finally {
            restoringQueue = false;
        }
    }

    private String readQueueStateRaw() {
        FileInputStream fis = null;
        try {
            fis = new FileInputStream(queueStateFile);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return bos.toString("UTF-8");
        } catch (Throwable t) {
            Log.w(TAG, "读取队列快照失败：" + t);
            return null;
        } finally {
            if (fis != null) {
                try {
                    fis.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /**
     * 系统媒体恢复（MediaSession.Callback）：手机重启/进程被杀后，系统媒体
     * 卡片点播放时由这里交出队列（这条路径需要真正开播）。
     */
    private ListenableFuture<MediaSession.MediaItemsWithStartPosition> buildResumptionFuture() {
        SettableFuture<MediaSession.MediaItemsWithStartPosition> future = SettableFuture.create();
        runOnMain(() -> {
            try {
                if (player == null || player.getMediaItemCount() == 0) {
                    restoreQueueState();
                }
                if (player == null || player.getMediaItemCount() == 0) {
                    future.setException(new IllegalStateException("无可恢复的播放队列"));
                    return;
                }
                ArrayList<MediaItem> items = new ArrayList<>();
                for (int i = 0; i < player.getMediaItemCount(); i++) {
                    items.add(player.getMediaItemAt(i));
                }
                future.set(new MediaSession.MediaItemsWithStartPosition(
                    ImmutableList.copyOf(items),
                    player.getCurrentMediaItemIndex(),
                    Math.max(0L, player.getCurrentPosition())));
            } catch (Throwable t) {
                future.setException(t);
            }
        });
        return future;
    }
}
