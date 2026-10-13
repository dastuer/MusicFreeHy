package com.huah.musicfree.hy;

import android.content.Context;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * 原生音频播放插件：WebView 的 <audio> 换成 ExoPlayer（Media3）。
 *
 * 为什么搬出 WebView（共播卡顿的根因）：
 *  - WebView 音频必须参与系统音频焦点仲裁，抖音等前台应用高频抢焦点时，
 *    每次拉锯都是一次可听的暂停；JS 侧回抢/巡逻只能缩短空隙，无法消除。
 *  - ExoPlayer 的 setAudioAttributes(applyFocus=…) 由我们自主决定：共播开
 *    时完全不入焦点仲裁（参考网易云的「不与其他应用同时播放」关掉语义的
 *    反向实现），抖音抢不抢焦点都影响不到这里；
 *  - 同时给足 30~60s 的网络缓冲（LoadControl），前台应用抢带宽时有存量可播。
 *
 * JS 侧 src/core/nativeAudio.ts 提供与 HTMLAudioElement 同形的事件代理，
 * trackPlayer 不感知后端差异。WebView <audio> 仍是回退路径（插件缺失时）。
 *
 * 事件（notifyListeners）：
 *  - audioEvent { type, ... }：play / pause / playing / ended / error / timeupdate /
 *    durationchange / progress / canplay / loadedmetadata / waiting / volumechange
 *  - bufferedUpdate { ms }：缓冲前沿，供 JS 侧换算 readyState/buffered
 */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {

    /** 原生音频可用性探测：包升级后插件就位、方法齐全才算可用 */
    public static final String SUPPORT_TAG = "1";

    private ExoPlayer player;
    /** 音频焦点是否交给系统仲裁（共播关=参与仲裁，共播开=完全不让） */
    private volatile boolean focusEnabled = true;
    private boolean lastPlayWhenReady = false;
    /** 上报进度用的主线程 Handler */
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable progressTicker;

    /**
     * ExoPlayer 要求全部访问都在创建线程（主线程）上，而 Capacitor 插件方法
     * 跑在 CapacitorPlugins 工作线程 —— 不切线程直接访问会在真机上炸进程。
     * 所有插件方法体都经这里转投主线程（Handler 队列 FIFO，天然保持到达顺序）。
     */
    private void onMain(Runnable r) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            r.run();
        } else {
            main.post(r);
        }
    }
    /** 共播模式转态瞬间（防焦点切换瞬间误发 pause 事件抖动 UI） */

    // ---------- 生命周期 ----------

    @Override
    public void load() {
        onMain(this::ensurePlayer);
        // 通知栏 / 耳机切歌的原生通路：服务直调播放器，页面 JS 冻结也能换歌
        MediaPlaybackService.setNativeTransport(direction -> {
            // ExoPlayer 只允许在创建线程（主线程）访问：万一调用方不在主线程，
            // 宁可不接管、交回 JS 走常规链路，也不冒炸进程的风险
            if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
                return null;
            }
            if (player == null || player.getMediaItemCount() < 2) {
                return null;
            }
            int index = player.getCurrentMediaItemIndex();
            boolean forward = !"previous".equals(direction);
            int target = forward ? index + 1 : index - 1;
            if (target < 0 || target >= player.getMediaItemCount()) {
                return null;
            }
            player.seekTo(target, 0L);
            player.setPlayWhenReady(true);
            String mediaId = currentMediaId();
            if (mediaId.isEmpty()) {
                return null;
            }
            return new MediaPlaybackService.SkipResult(mediaId, true);
        });
    }

    private synchronized void ensurePlayer() {
        if (player != null || getBridge() == null) {
            return;
        }
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            main.post(this::ensurePlayer);
            return;
        }
        try {
            Context ctx = getBridge().getContext();
            player = createPlayer(ctx);
            player.addListener(new Player.Listener() {
                @Override
                public void onIsPlayingChanged(boolean isPlaying) {
                    if (isPlaying) {
                        notifyEvent("playing", null);
                    }
                }

                @Override
                public void onPlaybackStateChanged(int state) {
                    switch (state) {
                        case Player.STATE_BUFFERING:
                            notifyEvent("waiting", null);
                            break;
                        case Player.STATE_READY:
                            notifyEvent("canplay", null);
                            notifyEvent("loadedmetadata", null);
                            notifyDuration();
                            break;
                        case Player.STATE_ENDED:
                            notifyEvent("ended", null);
                            break;
                        default:
                            break;
                    }
                }

                @Override
                public void onMediaItemTransition(@androidx.annotation.Nullable MediaItem mediaItem, int reason) {
                    // 播完当前曲自动续播预载的下一首（无缝换歌）：JS 侧靠 index >= 1
                    // 区分「自动续播」与 setSource 引起的过渡（后者 index 恒为 0）
                    int index = player.getCurrentMediaItemIndex();
                    if (index > 0) {
                        // 清掉身后的旧条目，列表保持「当前 + 至多一首预载」，不让它无限增长。
                        // 自动续播与通知栏原生「下一首」都会走到这；摘除的是已放过的条目，
                        // 不影响正在播的这首（「上一首」由 JS 侧播放历史负责，不依赖这里）
                        player.removeMediaItems(0, index);
                    }
                    // 通知栏跟上正在播的这首：页面 JS 被系统冻结时它接不到 itemtransition，
                    // 由这里直接按缓存的元数据刷新（取不到就只更新播放态）。
                    // 以播放器的真实播放态为准：setSource 引起的过渡常发生在暂停态下，
                    // 不能据此把通知翻成「播放中」
                    MediaPlaybackService.onNativeTrackChanged(currentMediaId(), player.isPlaying());
                    JSObject data = new JSObject();
                    data.put("index", index);
                    data.put("reason", reason);
                    notifyEvent("itemtransition", data);
                }

                @Override
                public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                    // 焦点被系统抢走且我们让位（共播关）时 reason=AUDIO_FOCUS_LOSS
                    if (playWhenReady != lastPlayWhenReady) {
                        lastPlayWhenReady = playWhenReady;
                        notifyEvent(playWhenReady ? "play" : "pause", null);
                    }
                }

                @Override
                public void onPlaybackParametersChanged(PlaybackParameters params) {
                    JSObject data = new JSObject();
                    data.put("rate", params.speed);
                    notifyEvent("ratechange", data);
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    JSObject data = new JSObject();
                    data.put("code", mapErrorCode(error));
                    data.put("message", String.valueOf(error.getMessage()));
                    notifyEvent("error", data);
                }
            });
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @androidx.annotation.OptIn(markerClass = UnstableApi.class)
    private ExoPlayer createPlayer(Context ctx) {
        // 网络 + 本地文件统一走 OkHttp 数据源：音源插件常有自定义请求头（UA/Referer）
        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();
        // OkHttp 默认跟随跨协议重定向（网易外链 302 https→http 也能落到），只补 UA
        HttpDataSource.Factory httpFactory = new OkHttpDataSource.Factory(client)
            .setUserAgent("Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 MusicFreeHy");
        DataSource.Factory dataSourceFactory = new DefaultDataSource.Factory(ctx, httpFactory);

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

        ExoPlayer p = new ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))
            .setLoadControl(loadControl)
            // 播放级优先级（高于下载/后台处理）：抢带宽时 ExoPlayer 的取流
            // 优先得到带宽，后台续播不被 WebView 页面加载 / 缓存任务挤到断流
            .setPriority(C.PRIORITY_PLAYBACK)
            .build();
        p.setWakeMode(C.WAKE_MODE_LOCAL);
        p.setHandleAudioBecomingNoisy(true);
        return p;
    }

    // ---------- JS 可调方法 ----------

    /** 探测插件可用性：老 APK 没有该插件，JS 侧据此回退 WebView <audio> */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            JSObject ret = new JSObject();
            ret.put("available", player != null);
            ret.put("tag", SUPPORT_TAG);
            call.resolve(ret);
        });
    }

    /**
     * 切换音频焦点仲裁。
     * focusEnabled=false（允许与其他应用同时播放）：不申请焦点、不响应任何焦点变化 ——
     * 抖音切视频随便抢，我们的播放纹丝不动（网易云等成熟播放器的做法）。
     * focusEnabled=true（默认独占）：走系统焦点仲裁，被抢即暂停。
     */
    @PluginMethod
    public void setAudioFocusMode(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player == null) {
                call.resolve();
                return;
            }
            Boolean focus = call.getBoolean("focusEnabled", Boolean.TRUE);
            focusEnabled = focus == null || focus;
            applyAudioAttributes();
            call.resolve();
        });
    }

    /**
     * 换源：src 为 JS 侧地址（https 直链 / capacitor 文件地址）；startMs 起播位置。
     * mediaId 是 JS 侧认歌用的键（platform-id）：页面被系统冻结期间播放器可能
     * 已自行续播，回前台后 JS 靠 getState 里的 currentMediaId 与它对齐状态。
     */
    @PluginMethod
    public void setSource(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player == null) {
                call.reject("player unavailable");
                return;
            }
            String src = call.getString("src", "");
            String mediaId = call.getString("mediaId", "");
            Double startMs = call.getDouble("startMs");
            boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", Boolean.FALSE));
            try {
                player.stop();
                player.clearMediaItems();
                if (src == null || src.isEmpty()) {
                    call.resolve();
                    return;
                }
                MediaItem item = buildItem(src, mediaId);
                if (startMs != null && startMs > 0) {
                    player.setMediaItem(item, startMs.longValue());
                } else {
                    player.setMediaItem(item);
                }
                player.prepare();
                if (autoplay) {
                    player.setPlayWhenReady(true);
                }
                lastPlayWhenReady = autoplay;
                call.resolve();
            } catch (Exception e) {
                call.reject("setSource failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player != null) {
                player.setPlayWhenReady(true);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player != null) {
                player.setPlayWhenReady(false);
            }
            call.resolve();
        });
    }

    /** 暂停并清空播放列表（对应 audio.removeAttribute("src") + load()） */
    @PluginMethod
    public void reset(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            call.resolve();
        });
    }

    /**
     * 无缝换歌预载：把下一首追加进播放列表末尾。当前曲目的缓冲打满后 ExoPlayer
     * 会接着预缓冲这一首，播完零间隙自动续播（歌曲切换不经过 JS，簿记走
     * itemtransition 事件）。
     */
    @PluginMethod
    public void appendNextSource(PluginCall call) {
        onMain(() -> {
            ensurePlayer();
            if (player == null) {
                call.reject("player unavailable");
                return;
            }
            String src = call.getString("src", "");
            String mediaId = call.getString("mediaId", "");
            if (src == null || src.isEmpty()) {
                call.resolve();
                return;
            }
            try {
                dropNextSources();
                player.addMediaItem(buildItem(src, mediaId));
                call.resolve();
            } catch (Exception e) {
                call.reject("appendNextSource failed: " + e.getMessage());
            }
        });
    }

    /** 撤下预载曲目（JS 侧队列变动 / 换歌时调用；setSource/reset 本身会清空列表） */
    @PluginMethod
    public void clearNextSources(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                dropNextSources();
            }
            call.resolve();
        });
    }

    /** 移除当前曲目之后的全部条目（预载位） */
    private void dropNextSources() {
        int from = Math.max(player.getCurrentMediaItemIndex() + 1, 1);
        int count = player.getMediaItemCount();
        if (count > from) {
            player.removeMediaItems(from, count - from);
        }
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                Double ms = call.getDouble("positionMs");
                if (ms != null) {
                    player.seekTo(ms.longValue());
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                Double rate = call.getDouble("rate", 1d);
                float r = rate == null ? 1f : rate.floatValue();
                player.setPlaybackSpeed(Math.min(Math.max(r, 0.05f), 4f));
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                Double volume = call.getDouble("volume", 1d);
                float v = volume == null ? 1f : volume.floatValue();
                player.setVolume(Math.min(Math.max(v, 0f), 1f));
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        onMain(() -> {
            JSObject ret = new JSObject();
            if (player == null) {
                ret.put("available", false);
                call.resolve(ret);
                return;
            }
            ret.put("available", true);
            ret.put("paused", !player.getPlayWhenReady());
            ret.put("ended", player.getPlaybackState() == Player.STATE_ENDED);
            ret.put("positionMs", player.getCurrentPosition());
            ret.put("bufferedMs", player.getBufferedPosition());
            ret.put("durationMs", player.getDuration());
            ret.put("rate", player.getPlaybackParameters().speed);
            ret.put("volume", player.getVolume());
            ret.put("loop", player.getRepeatMode() == Player.REPEAT_MODE_ONE);
            ret.put("readyState", mapReadyState(player.getPlaybackState()));
            // 供 JS 回前台对账：页面被冻结期间播放器可能已自行播到了另一首
            ret.put("currentMediaId", currentMediaId());
            ret.put("playing", player.isPlaying());
            call.resolve(ret);
        });
    }

    /** 当前曲目的 mediaId（setMediaItem 时写在 MediaItem 上；取不到返回空串） */
    private String currentMediaId() {
        if (player == null) {
            return "";
        }
        MediaItem item = player.getCurrentMediaItem();
        if (item == null || item.mediaId == null) {
            return "";
        }
        return item.mediaId;
    }

    /** 统一的 MediaItem 构造：把 JS 侧认歌的键挂到 mediaId 上 */
    private MediaItem buildItem(String src, String mediaId) {
        MediaItem item = MediaItem.fromUri(resolveSrc(src));
        if (mediaId != null && !mediaId.isEmpty()) {
            return item.buildUpon().setMediaId(mediaId).build();
        }
        return item;
    }

    @PluginMethod
    public void setLoop(PluginCall call) {
        onMain(() -> {
            if (player != null) {
                Boolean loop = call.getBoolean("loop", Boolean.FALSE);
                player.setRepeatMode(Boolean.TRUE.equals(loop) ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            }
            call.resolve();
        });
    }

    /** 每秒推 timeupdate（对应 HTMLAudioElement 的 timeupdate 节奏） */
    @PluginMethod
    public void startProgressTicker(PluginCall call) {
        onMain(() -> {
            startTicker();
            call.resolve();
        });
    }

    @PluginMethod
    public void stopProgressTicker(PluginCall call) {
        onMain(() -> {
            stopTicker();
            call.resolve();
        });
    }

    // ---------- 内部 ----------

    @androidx.annotation.OptIn(markerClass = UnstableApi.class)
    private void applyAudioAttributes() {
        if (player == null) {
            return;
        }
        androidx.media3.common.AudioAttributes attrs =
            new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();
        // 共播开（focusEnabled=false）：applyFocus=false —— 不申请焦点，也不被焦点打断
        player.setAudioAttributes(attrs, focusEnabled);
    }

    /** src 归一化：capacitor 文件地址还原为 file:// 绝对路径（ExoPlayer 文件数据源需要 scheme） */
    private String resolveSrc(String src) {
        // https://localhost/_capacitor_file_/storage/emulated/0/... → file:///storage/emulated/0/...
        int fileMark = src.indexOf("/_capacitor_file_");
        if (fileMark >= 0) {
            return "file://" + src.substring(fileMark + "/_capacitor_file_".length());
        }
        return src;
    }

    private int mapReadyState(int playbackState) {
        switch (playbackState) {
            case Player.STATE_READY:
                return 4; // HAVE_ENOUGH_DATA
            case Player.STATE_BUFFERING:
                return 3; // HAVE_FUTURE_DATA（正在补缓冲）
            case Player.STATE_ENDED:
                return 4;
            default:
                return 1; // HAVE_METADATA 之前
        }
    }

    private int mapErrorCode(PlaybackException error) {
        if (error == null || error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED) {
            return 2; // MEDIA_ERR_NETWORK
        }
        int code = error.errorCode;
        if (code >= 2000 && code < 3000) {
            return 2; // IO 类 → 网络错误
        }
        if (code >= 3000 && code < 4000) {
            return 4; // 解析/格式 → 不支持
        }
        if (code >= 1000 && code < 2000) {
            return 3; // 解码 → 解码错误
        }
        return 2;
    }

    private void notifyEvent(String type, JSObject data) {
        if (getBridge() == null) {
            return;
        }
        JSObject payload = data == null ? new JSObject() : data;
        payload.put("type", type);
        notifyListeners("audioEvent", payload);
    }

    private void notifyDuration() {
        if (player == null) {
            return;
        }
        JSObject data = new JSObject();
        data.put("durationMs", player.getDuration());
        notifyEvent("durationchange", data);
    }

    private void startTicker() {
        if (progressTicker != null) {
            return;
        }
        progressTicker = new Runnable() {
            @Override
            public void run() {
                if (player == null || progressTicker == null) {
                    return;
                }
                JSObject data = new JSObject();
                data.put("positionMs", player.getCurrentPosition());
                data.put("bufferedMs", player.getBufferedPosition());
                data.put("durationMs", player.getDuration());
                data.put("paused", !player.getPlayWhenReady());
                notifyEvent("timeupdate", data);
                main.postDelayed(progressTicker, 1000);
            }
        };
        main.postDelayed(progressTicker, 1000);
    }

    private void stopTicker() {
        if (progressTicker != null) {
            main.removeCallbacks(progressTicker);
            progressTicker = null;
        }
    }
}
