package com.huah.musicfree.hy;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;

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

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * 原生播放内核：Media3 MediaSessionService 托管 ExoPlayer。
 *
 * 为什么播放器要住进服务、持有整条队列（后台连播的根治）：
 *  - 音源解析只能在 WebView JS 里跑（音源插件机制），而熄屏后台的渲染进程
 *    会被部分 ROM 无视优先级建议直接冻结——「下一首放什么」的控制面不能依赖
 *    JS 存活。前台时 JS 把接下来几首的已解析音源推进这里的播放列表
 *    （PlaybackBridge.pushQueueWindow），之后预缓冲、逐首自动续播、通知栏
 *    切歌/暂停/拖进度全部由原生完成，JS 死了也不影响。
 *  - MediaSessionService 自带前台服务生命周期与系统媒体通知
 *    （DefaultMediaNotificationProvider）：元数据随 MediaItem 走，封面/标题/
 *    播放态由系统渲染，不再手写 MediaStyle 通知与封面解码。
 *  - ExoPlayer setWakeMode(WAKE_MODE_NETWORK) 自管唤醒锁，熄屏断流取流
 *    不再需要服务侧的 WakeLock/WifiLock 心跳。
 *
 * JS 侧经 PlaybackBridge 桥接：播放控制直达这里，状态事件原路转发。
 */
public class MediaPlaybackService extends MediaSessionService {

    /** 播放列表里「当前曲之后」保留的预载上限（与 JS 侧窗口镜像一致） */
    static final int QUEUE_WINDOW_MAX = 2;
    /** transition 后保留的已播条目数：通知栏/耳机「上一首」由原生直切 */
    private static final int KEEP_BEHIND = 2;
    /** 队列自愈的连续失败上限：连续这么多首取流失败才真正停下 */
    private static final int MAX_CONSECUTIVE_ERRORS = 5;
    /** 连续取流失败计数（成功开播即清零，见 onIsPlayingChanged） */
    private int consecutiveErrors = 0;

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
                emitPlaybackEvent("itemtransition", currentMediaId(), String.valueOf(index));
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitPlaybackEvent(isPlaying ? "playing" : "pause", currentMediaId(), null);
                if (isPlaying) {
                    consecutiveErrors = 0;
                    main.removeCallbacks(progressTick);
                    main.postDelayed(progressTick, PROGRESS_INTERVAL_MS);
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
                if (playbackState == Player.STATE_READY) {
                    // 时长就绪：JS 侧进度条/窗口镜像依赖它
                    emitPlaybackData(
                        "durationchange",
                        currentMediaId(),
                        "{\"durationMs\":" + player.getDuration() + "}"
                    );
                }
                if (playbackState == Player.STATE_ENDED) {
                    // 队列播尽（窗口耗尽且 JS 冻结没能补）：置为暂停态并落位到 0，
                    // 通知栏翻成「播放键」而不是停在假播放中——用户可见地知道停了，
                    // 回前台 JS 复活后对账会按现实恢复续播
                    if (player.getCurrentMediaItemIndex() + 1 >= player.getMediaItemCount()) {
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
                boolean recovered = false;
                if (player.getCurrentMediaItemIndex() + 1 < player.getMediaItemCount()) {
                    // ERROR 态下播放器已停止：seek + prepare 后必须重新声明
                    // playWhenReady=true 才会真正续播（prepare 不继承播放意图）
                    player.seekToNextMediaItem();
                    player.prepare();
                    player.setPlayWhenReady(true);
                    recovered = true;
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
        DataSource.Factory dataSourceFactory = new DefaultDataSource.Factory(this, httpFactory);

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
     * autoplay=true 立即开播。
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
     * 队列窗口镜像：把接下来几首的已解析音源替换到「当前曲之后」。
     * 前台 JS 做完解析后调用；之后当前曲播完由 ExoPlayer 自动无缝续播，
     * 全程不经过 JS。每条携带元数据，通知栏/锁屏能直接显示下一首。
     */
    void pushQueueWindow(androidx.collection.ArrayMap<String, String[]> items) {
        runOnMain(() -> {
            if (player == null) {
                return;
            }
            dropNextSources();
            int count = 0;
            for (int i = 0; i < items.size() && count < QUEUE_WINDOW_MAX; i++) {
                String key = items.keyAt(i);
                String[] v = items.valueAt(i);
                // v: [src, title, artist, album, artworkUri]
                if (v == null || v.length < 5 || v[0] == null || v[0].isEmpty()) {
                    continue;
                }
                rememberSrc(key, v[0]);
                player.addMediaItem(buildItem(v[0], key, v[1], v[2], v[3], v[4]));
                count++;
            }
        });
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
            if (player != null) {
                player.setPlayWhenReady(true);
            }
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

    /** 把「下一首」的状态交给 JS 镜像簿记：transition 后 JS 会按 mediaId 对账 */
    String nextMediaId() {
        if (player == null) {
            return "";
        }
        int next = player.getCurrentMediaItemIndex() + 1;
        if (next >= player.getMediaItemCount()) {
            return "";
        }
        MediaItem item = player.getMediaItemAt(next);
        return item == null || item.mediaId == null ? "" : item.mediaId;
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
