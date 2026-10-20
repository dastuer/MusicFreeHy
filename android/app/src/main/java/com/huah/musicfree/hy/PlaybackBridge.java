package com.huah.musicfree.hy;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 播放桥：WebView JS ↔ MediaPlaybackService（原生播放内核）。
 *
 * 方法都是薄封装：把参数转给服务的内部入口（服务侧统一切主线程操作 ExoPlayer）。
 * 服务的事件经 setPlaybackListener 回到这里 notifyListeners("audioEvent")，
 * JS 侧 src/core/nativeAudio.ts 的 NativeAudioElement 代理接收。
 *
 * 队列归属：JS 把整条队列（元数据 + 可空 src + 曲目快照）经 setQueue 交给原生，
 * 队列推进与音源解析都在原生（缺源条目临播前由 LazyAudioDataSource 跑 QuickJS
 * 自己解析）；shuffle/repeat 也归原生。JS 只是遥控器，后台连播不依赖 JS 存活。
 */
@CapacitorPlugin(
    name = "PlaybackBridge",
    permissions = {
        @Permission(strings = { android.Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
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

    /**
     * 单曲装载：src + mediaId（platform-id）+ 起播位置 + 是否自动开播 + 元数据。
     * payload/quality 是当前曲的曲目快照与请求音质（可选）：直链过期时原生靠它
     * 重跑 getMediaSource 原地换源，不必跳歌。
     */
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
        JSObject payload = call.getObject("payload");
        svc.loadTrack(
            src,
            mediaId,
            startMs == null ? 0L : startMs.longValue(),
            autoplay,
            call.getString("title", ""),
            call.getString("artist", ""),
            call.getString("album", ""),
            call.getString("artworkUri", ""),
            payloadJson(payload),
            call.getString("quality", "")
        );
        call.resolve();
    }

    /**
     * 整条队列入档：items = [{ mediaId, src, title, artist, album, artworkUri,
     * payload, quality }]，按播放顺序排列。
     *
     * src 可空：空表示「这条交给原生临播前解析」——条目以占位 URI 进播放器，
     * ExoPlayer 预缓冲到它时由 LazyAudioDataSource 跑 QuickJS 拿直链。因此
     * `payload` 是缺源条目的**必需**字段（没它就解析不了，会按坏条目跳过）。
     *
     * currentMediaId：新队列里哪一首是当前曲（保持不打断；传空则从队首开始）。
     * shuffle/mode：播放顺序（mode = off | queue | single；queue 即随机播放）。
     */
    @PluginMethod
    public void setQueue(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        JSArray items = call.getArray("items");
        List<MediaPlaybackService.Planned> queue = new ArrayList<>();
        if (items != null) {
            try {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject o = items.getJSONObject(i);
                    if (o == null) {
                        continue;
                    }
                    String mediaId = o.optString("mediaId", "");
                    if (mediaId.isEmpty()) {
                        continue;
                    }
                    queue.add(new MediaPlaybackService.Planned(
                        mediaId,
                        o.optString("src", ""),
                        o.optString("title", ""),
                        o.optString("artist", ""),
                        o.optString("album", ""),
                        o.optString("artworkUri", ""),
                        payloadJson(o),
                        o.optString("quality", "")
                    ));
                }
            } catch (Exception e) {
                call.reject("setQueue failed: " + e.getMessage());
                return;
            }
        }
        svc.setQueue(
            queue,
            call.getString("currentMediaId", ""),
            Boolean.TRUE.equals(call.getBoolean("shuffle", Boolean.FALSE)),
            call.getString("mode", "off")
        );
        call.resolve();
    }

    /** 播放顺序（shuffle/repeat 归原生）：mode = off | queue（随机）| single */
    @PluginMethod
    public void setPlaybackOrder(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.setPlaybackOrder(
            Boolean.TRUE.equals(call.getBoolean("shuffle", Boolean.FALSE)),
            call.getString("mode", "off")
        );
        call.resolve();
    }

    /** payload 上限：超过就不收（原生解析用不到这么大快照，防内存膨胀） */
    private static final int MAX_PAYLOAD_JSON = 64 * 1024;

    /** 取条目里的曲目快照 JSON（缺失/超限/异常一律给空串 = 放弃原生解析该条） */
    private static String payloadJson(JSONObject o) {
        try {
            return clampPayload(o.optJSONObject("payload"));
        } catch (Exception e) {
            return "";
        }
    }

    /** 同上，但入参是 Capacitor 的 JSObject（loadTrack 直接传 payload 对象时） */
    private static String payloadJson(JSObject payload) {
        return clampPayload(payload);
    }

    private static String clampPayload(JSONObject payload) {
        if (payload == null) {
            return "";
        }
        try {
            String json = payload.toString();
            return json.length() <= MAX_PAYLOAD_JSON ? json : "";
        } catch (Exception e) {
            return "";
        }
    }

    /** 补一条已解析音源（JS 侧缓存落盘本地化 / 主动补源）：就地替换条目地址 */
    @PluginMethod
    public void supplySource(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.supplySource(call.getString("mediaId", ""), call.getString("src", ""));
        call.resolve();
    }

    /** 撤一条队列条目（JS 解析失败/冷却跳过） */
    @PluginMethod
    public void dropPlanned(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        svc.dropPlanned(call.getString("mediaId", ""));
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

    /** 跳到队列里的指定条目（JS 手动点播窗口内已有的歌）：命中返回 mediaId，未命中空串 */
    @PluginMethod
    public void jumpToItem(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        String mediaId = call.getString("mediaId", "");
        final PluginCall pending = call;
        svc.runOnMain(() -> {
            String jumped = svc.jumpToMediaItem(mediaId);
            JSObject ret = new JSObject();
            ret.put("mediaId", jumped == null ? "" : jumped);
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

    /**
     * 音频硬件直通（Audio Offload）开关：默认开。打开其他应用时 CPU 被抢占，
     * 直通让 DSP 解码出声、几乎不吃应用 CPU，是后台防卡顿的主力手段；个别
     * ROM 直通有兼容问题（无声/爆音）时可在设置页关闭，回退普通解码。
     */
    @PluginMethod
    public void setAudioOffloadMode(PluginCall call) {
        MediaPlaybackService svc = activeService;
        if (svc == null) {
            call.reject("service unavailable");
            return;
        }
        Boolean enabled = call.getBoolean("enabled");
        svc.setAudioOffloadEnabled(enabled == null || enabled);
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
            // 暂停是否用户发起：JS 回前台只对「非用户暂停」补播
            ret.put("pausedByUser", svc.isPausedByUser());
            ret.put("ended", svc.isEnded());
            ret.put("playing", svc.isPlaying());
            ret.put("hasNext", svc.hasNext());
            ret.put("awaitingSource", svc.isAwaitingSource());
            ret.put("plannedCount", svc.plannedCount());
            ret.put("plannedHead", svc.plannedHeadMediaId());
            ret.put("rate", svc.currentRate());
            ret.put("volume", svc.currentVolume());
            pending.resolve(ret);
        });
    }

    // ---------- 服务绑定 ----------

    /**
     * Android 13+ 通知权限（前台服务通知的前提）：未授予时 Media3 发不出
     * 前台通知，服务不进 FGS，熄屏约 90s 被系统回收（后台停播的直接原因之一）。
     * JS 侧首次开播时调用（mediaNotification.ensurePermissionOnce）。
     */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        JSObject res = new JSObject();
        if (android.os.Build.VERSION.SDK_INT < 33) {
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            res.put("granted", true);
            call.resolve(res);
            return;
        }
        requestPermissionForAlias("notifications", call, "onNotificationPermissionResult");
    }

    @PermissionCallback
    private void onNotificationPermissionResult(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(res);
    }

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
