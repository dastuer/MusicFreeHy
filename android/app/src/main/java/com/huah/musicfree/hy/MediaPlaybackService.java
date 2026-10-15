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
    private final android.os.Handler main =
        new android.os.Handler(android.os.Looper.getMainLooper());

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
        mediaSession = new MediaSession.Builder(this, player)
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
            })
            .build();
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
                // 拿新直链（excludeUrl 用刚失败的那条）。重试次数用尽才跳歌；
                // 连续多首全失败才真正放弃（整队坏源时避免静默空转烧电）。
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

        // 音频输出缓冲下限 500ms（平台默认约 20~100ms）：其他应用冷启动的调度
        // 尖峰（CPU/IO 被抢占、音频线程短暂饿死）只要不超过这个余量，AudioTrack
        // 靠存量数据顶着继续出声，听感上就是「无感平滑」。Media3 的 ExoPlayer.Builder
        // 没有直接的 setAudioSink，经 RenderersFactory 覆写 buildAudioSink 注入。
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
            int existingIndex = indexOfMediaId(current);
            int target = 0;
            if (!current.isEmpty()) {
                for (int i = 0; i < mediaItems.size(); i++) {
                    if (current.equals(mediaItems.get(i).mediaId)) {
                        target = i;
                        break;
                    }
                }
            }
            boolean keepPlaying = existingIndex >= 0
                && current.equals(currentMediaId())
                && player.getPlaybackState() != Player.STATE_IDLE;
            if (keepPlaying) {
                // 当前曲没变、也没被换掉：只重排其后的列表，不打断正在播的这首。
                // 做法与旧 pushQueuePlan 的「窗内条目保留」同思路，但范围是整队。
                long pos = player.getCurrentPosition();
                boolean wasPlaying = player.getPlayWhenReady();
                player.setMediaItems(mediaItems, existingIndex, pos);
                player.setPlayWhenReady(wasPlaying);
            } else {
                boolean wasPlaying = player.getPlayWhenReady();
                player.setMediaItems(mediaItems, target, 0L);
                player.prepare();
                player.setPlayWhenReady(wasPlaying || !current.isEmpty());
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
            meta.setArtworkUri(Uri.parse(p.artworkUri));
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
