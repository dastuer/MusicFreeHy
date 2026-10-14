package com.huah.musicfree.hy;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * 播放桥：WebView JS ↔ MediaPlaybackService（原生播放内核）。
 *
 * 方法都是薄封装：把参数转给服务的内部入口（服务侧统一切主线程操作 ExoPlayer）。
 * 服务的事件经 setPlaybackListener 回到这里 notifyListeners("audioEvent")，
 * JS 侧 src/core/nativeAudio.ts 的 NativeAudioElement 代理接收。
 *
 * 播放主链路（装载/窗口/播放/seek/音量/倍速/循环/焦点模式）都直达服务，
 * 通知栏与耳机按键由 Media3 MediaSession 处理，不经过这个桥。
 */
@CapacitorPlugin(name = "PlaybackBridge")
public class PlaybackBridge extends Plugin {

    private static final String TAG_SUPPORT = "1";

    /** 活跃的服务实例：MediaPlaybackService.onCreate 登记 / onDestroy 注销 */
    static volatile MediaPlaybackService activeService;

    /** 探测插件可用性（老包没有该插件时 JS 回退 WebView <audio>） */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("tag", TAG_SUPPORT);
        call.resolve(ret);
    }

    /** 单曲装载：src + mediaId（platform-id）+ 起播位置 + 是否自动开播 + 元数据 */
    @PluginMethod
    public void loadTrack(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        String src = call.getString("src", "");
        String mediaId = call.getString("mediaId", "");
        Double startMs = call.getDouble("startMs");
        boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", Boolean.FALSE));
        svc.loadTrack(
            src,
            mediaId,
            startMs == null ? 0L : startMs.longValue(),
            autoplay,
            call.getString("title", ""),
            call.getString("artist", ""),
            call.getString("album", ""),
            call.getString("artworkUri", "")
        );
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.pause();
        call.resolve();
    }

    /** 暂停并清空播放列表（对应 audio.removeAttribute("src") + load()） */
    @PluginMethod
    public void stop(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.stop();
        call.resolve();
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        Double ms = call.getDouble("positionMs");
        svc.seekTo(ms == null ? 0L : ms.longValue());
        call.resolve();
    }

    /** 原生队列直切（通知栏同款通路）：返回切到的 mediaId，没有目标返回空串。
     *  ExoPlayer 只许主线程访问：切主线程执行后回填结果。 */
    @PluginMethod
    public void skip(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        String direction = call.getString("direction", "next");
        final boolean forward = !"previous".equals(direction);
        final PluginCall pending = call;
        svc.runOnMain(() -> {
            String mediaId = svc.skip(forward ? 1 : -1);
            JSObject ret = new JSObject();
            ret.put("mediaId", mediaId == null ? "" : mediaId);
            pending.resolve(ret);
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        Double rate = call.getDouble("rate", 1d);
        svc.setRate(rate == null ? 1f : rate.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        Double volume = call.getDouble("volume", 1d);
        svc.setVolume(volume == null ? 1f : volume.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setRepeatMode(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.setRepeatMode(Boolean.TRUE.equals(call.getBoolean("repeatOne", Boolean.FALSE)));
        call.resolve();
    }

    @PluginMethod
    public void setAudioFocusMode(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        Boolean focus = call.getBoolean("focusEnabled");
        // 缺省 false：与服务的默认一致（不入仲裁，抖音抢焦点不影响播放）
        svc.setAudioFocusMode(focus != null && focus);
        call.resolve();
    }

    /** 播放器真实状态快照（回前台对账用）。ExoPlayer 只许主线程访问：统一切主线程再读。 */
    @PluginMethod
    public void getState(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            JSObject unavailable = new JSObject();
            unavailable.put("available", false);
            call.resolve(unavailable);
            return;
        }
        final PluginCall pending = call;
        svc.runOnMain(() -> {
            JSObject ret = new JSObject();
            ret.put("available", true);
            ret.put("hasPlayer", svc.hasPlayer());
            ret.put("currentMediaId", svc.currentMediaId());
            ret.put("currentSrc", svc.currentSrc());
            ret.put("positionMs", svc.currentPositionMs());
            ret.put("bufferedMs", svc.currentBufferedMs());
            long dur = svc.currentDurationMs();
            ret.put("durationMs", dur == androidx.media3.common.C.TIME_UNSET ? 0L : dur);
            ret.put("paused", svc.isPaused());
            ret.put("ended", svc.isEnded());
            ret.put("playing", svc.isPlaying());
            ret.put("hasNext", svc.hasNext());
            ret.put("rate", svc.currentRate());
            ret.put("volume", svc.currentVolume());
            pending.resolve(ret);
        });
    }

    // ---------- 服务绑定 ----------

    /**
     * 起播放服务（JS 侧初始化时调用）。用 startService 而非
     * startForegroundService：后者要求 5 秒内 startForeground，JS 侧「先起服务、
     * 稍后才 loadTrack 开播」的节奏会超时，被系统判定 ANR 直接杀进程（表现为
     * 「播放一段时间后 app 异常退出」）。Media3 语义下服务在真正开播时
     * 才需要前台身份，届时框架会自动晋升，不需要这里抢跑。
     */
    @PluginMethod
    public void ensureService(PluginCall call) {
        if (activeService != null) {
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(getContext(), MediaPlaybackService.class);
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("ensureService failed: " + e.getMessage());
        }
    }

    /**
     * 除本应用外还有几个媒体会话在活跃播放（共播检测）。
     * 共播时缓存下载要做带宽让路（分段节流），播放取流优先。
     */
    @PluginMethod
    public void otherMediaPlaying(PluginCall call) {
        try {
            android.media.AudioManager am = (android.media.AudioManager)
                getContext().getSystemService(Context.AUDIO_SERVICE);
            int count = 0;
            if (am != null) {
                for (android.media.AudioPlaybackConfiguration cfg :
                    am.getActivePlaybackConfigurations()) {
                    // 只认真正的媒体用途（USAGE_MEDIA 1 / GAME 2），通话、提示音不算
                    int usage = cfg.getAudioAttributes().getUsage();
                    if (usage == android.media.AudioAttributes.USAGE_MEDIA
                        || usage == android.media.AudioAttributes.USAGE_GAME) {
                        count++;
                    }
                }
            }
            JSObject ret = new JSObject();
            // 减 1：我们自己（ExoPlayer 的 AudioTrack）也在这份列表里；
            // 服务没起时没有自家会话，不做减法也只会多算一次，宁多让不少让
            ret.put("count", Math.max(count - (activeService != null ? 1 : 0), 0));
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("count", 0);
            call.resolve(ret);
        }
    }

    // ---------- 电池优化（原 MediaNotificationPlugin 迁入） ----------

    @PluginMethod
    public void isBatteryOptimizationIgnored(PluginCall call) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean ignored = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            JSObject ret = new JSObject();
            ret.put("ignored", ignored);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Context ctx = getContext();
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + ctx.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            // 厂商 ROM 裁剪了该设置页：退到应用详情页
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception inner) {
                call.reject(inner.getMessage());
            }
        }
    }

    // ---------- 生命周期 ----------

    @Override
    public void load() {
        // 服务事件 → JS：play/pause/playing/ended/error/itemtransition/timeupdate/durationchange。
        // timeupdate/durationchange 的 extra 是 JSON 数值载荷，平铺进事件对象
        // （JS 侧读 data.positionMs 等）
        MediaPlaybackService.setPlaybackListener((evt, mediaId, extra) -> {
            JSObject data = new JSObject();
            data.put("type", evt);
            if (mediaId != null) {
                data.put("mediaId", mediaId);
            }
            if (extra != null) {
                boolean parsed = false;
                String trimmed = extra.trim();
                if (trimmed.startsWith("{")) {
                    try {
                        JSONObject payload = new JSONObject(trimmed);
                        java.util.Iterator<String> keys = payload.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            data.put(k, payload.get(k));
                        }
                        parsed = true;
                    } catch (Exception ignored) {
                    }
                }
                if (!parsed) {
                    // 非 JSON（如 transition 的 index、error 的错误码）
                    try {
                        data.put("index", Integer.parseInt(trimmed));
                    } catch (NumberFormatException nfe) {
                        data.put("detail", extra);
                    }
                }
            }
            notifyListeners("audioEvent", data);
        });
    }
}
