package com.huah.musicfree.hy;

import android.media.audiofx.BassBoost;
import android.media.audiofx.EnvironmentalReverb;
import android.media.audiofx.Equalizer;
import android.media.audiofx.Virtualizer;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 原生音效链（挂在 ExoPlayer 的 audioSessionId 上）：
 *
 *   Equalizer(10 段映射到设备 band) + BassBoost + Virtualizer + EnvironmentalReverb
 *
 * 与桌面版 Web Audio 链（Web Audio 的 BiquadFilter/M-S 矩阵/卷积混响）功能对齐，
 * 但实现完全不同——Android 上音频由 ExoPlayer 在原生层解码输出，WebView 的
 * Web Audio 碰不到这段流，必须用系统音频效果框架（android.media.audiofx）。
 *
 * 参数来自 JS 侧 audioEffect 设置（PlaybackBridge.setAudioEffect 全量下发，幂等）：
 *   enabled           总开关；关闭时所有效果器 setEnabled(false)（等效旁路）
 *   eqs[10]           十段增益 dB（-12..12），对数频率插值映射到设备 band
 *   bass / treble     低音/高音增强 dB（-12..12）；BassBoost 只能增强，衰减走 EQ 低频段
 *   surroundStrength  0..1 → Virtualizer strength（Android 侧只有"加宽"，没有收窄）
 *   surroundDepth     0..1 → EnvironmentalReverb 早期反射延迟/衰减微调（空间纵深感）
 *   reverb            环境音效预设名（与 JS 侧 REVERB_PRESETS 同一张表）
 *
 * 设备兼容性：AudioEffect 构造可能抛异常（部分 ROM 裁剪），逐个 try/catch——
 * 拿不到的效果器按「不支持」跳过，不影响其它效果与正常播放。
 */
public class AudioFx {

    private static final String TAG = "AudioFx";

    /** JS 侧十段均衡器的中心频率（Hz），与 EQ_BANDS 一一对应 */
    private static final float[] EQ_BANDS = {31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};

    /** JS 侧增益范围（dB）；设备 band level 范围不同时按比例缩放 */
    private static final float JS_GAIN_LIMIT = 12f;

    private Equalizer equalizer;
    private BassBoost bassBoost;
    private Virtualizer virtualizer;
    private EnvironmentalReverb reverb;

    /** 当前挂载的 audio session；-1 = 未挂载 */
    private int sessionId = -1;

    /** 最近一次下发的参数：session 重建（换输出设备等）时按它恢复 */
    private JSONObject lastParams;

    /** 是否有任一效果处于开启状态（联动 offload：直通模式下 AudioFX 不生效） */
    private boolean anyEnabled = false;

    /** 效果器能力探测结果（构造失败 = 设备不支持，之后不再尝试） */
    private boolean eqSupported = true;
    private boolean bassSupported = true;
    private boolean virtSupported = true;
    private boolean reverbSupported = true;

    /** 最近一次 apply 的参数快照（getState 用，调试/对账） */
    private volatile String lastAppliedJson = "{}";

    // ---------- 生命周期 ----------

    /**
     * 挂到 audioSession 上。ExoPlayer 的 session id 在 player 生命周期内稳定，
     * 换歌不换 session；player release 后重建（服务重启）会拿到新 id，需重新 attach。
     * 已挂到同一 session 时重复调用是幂等的。
     */
    synchronized void attach(int audioSessionId) {
        if (audioSessionId <= 0) {
            Log.i(TAG, "attach 跳过：session 未就绪 (" + audioSessionId + ")");
            return;
        }
        if (sessionId == audioSessionId && equalizer != null) {
            return;
        }
        release();
        sessionId = audioSessionId;
        try {
            equalizer = new Equalizer(0, audioSessionId);
        } catch (Throwable t) {
            equalizer = null;
            eqSupported = false;
            Log.w(TAG, "Equalizer 不可用：" + t);
        }
        try {
            bassBoost = new BassBoost(0, audioSessionId);
        } catch (Throwable t) {
            bassBoost = null;
            bassSupported = false;
            Log.w(TAG, "BassBoost 不可用：" + t);
        }
        try {
            virtualizer = new Virtualizer(0, audioSessionId);
        } catch (Throwable t) {
            virtualizer = null;
            virtSupported = false;
            Log.w(TAG, "Virtualizer 不可用：" + t);
        }
        try {
            reverb = new EnvironmentalReverb(0, audioSessionId);
        } catch (Throwable t) {
            reverb = null;
            reverbSupported = false;
            Log.w(TAG, "EnvironmentalReverb 不可用：" + t);
        }
        Log.i(TAG, "音效已挂载 session=" + audioSessionId
            + " eq=" + eqSupported + " bass=" + bassSupported
            + " virt=" + virtSupported + " reverb=" + reverbSupported);
        // 重建后按最近参数恢复（换设备等场景下音效不丢）
        if (lastParams != null) {
            apply(lastParams);
        }
    }

    /** 释放全部效果器（player 释放前调用，避免 audio session 泄漏） */
    synchronized void release() {
        releaseQuietly(equalizer);
        releaseQuietly(bassBoost);
        releaseQuietly(virtualizer);
        releaseQuietly(reverb);
        equalizer = null;
        bassBoost = null;
        virtualizer = null;
        reverb = null;
        sessionId = -1;
    }

    private static void releaseQuietly(android.media.audiofx.AudioEffect fx) {
        if (fx != null) {
            try {
                fx.release();
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------- 参数应用 ----------

    /** 全量应用一份设置（JSON 来自 JS，字段见类注释）。坏字段按默认值处理，不抛出 */
    synchronized void apply(JSONObject params) {
        if (params == null) {
            return;
        }
        lastParams = params;
        lastAppliedJson = params.toString();
        boolean enabled = params.optBoolean("enabled", false);
        anyEnabled = enabled;
        applyEqualizer(params, enabled);
        applyBass(params, enabled);
        applyVirtualizer(params, enabled);
        applyReverb(params, enabled);
    }

    /** 十段曲线 → 设备 band：对数频率插值 + 增益范围等比缩放 */
    private void applyEqualizer(JSONObject params, boolean enabled) {
        if (equalizer == null) {
            return;
        }
        try {
            short bands = equalizer.getNumberOfBands();
            short[] range = equalizer.getBandLevelRange();
            // 设备 band level 范围（millibels）。设备普遍 ±1500，按它把 JS 的 ±12dB 缩放过去
            float maxMilliBel = Math.min(-range[0], range[1]) / 1000f;
            float scale = maxMilliBel / JS_GAIN_LIMIT;

            float[] jsGains = new float[EQ_BANDS.length];
            JSONArray arr = params.optJSONArray("eqs");
            for (int i = 0; i < EQ_BANDS.length; i++) {
                float v = 0f;
                if (arr != null && i < arr.length()) {
                    v = (float) arr.optDouble(i, 0d);
                }
                jsGains[i] = Math.max(-JS_GAIN_LIMIT, Math.min(JS_GAIN_LIMIT, v));
            }

            // 高音没有专属效果器：以 6kHz 为转折的高频搁架直接叠加进曲线
            // （treble>0 提亮、<0 收暗）；低音的负值同理走 200Hz 低频搁架——
            // BassBoost 只能增强，衰减只能靠 EQ。
            float treble = (float) params.optDouble("treble", 0d);
            float bass = (float) params.optDouble("bass", 0d);
            float[] curve = new float[EQ_BANDS.length];
            for (int i = 0; i < EQ_BANDS.length; i++) {
                float g = jsGains[i];
                if (treble != 0f) {
                    g += shelfGain(EQ_BANDS[i], 6000f, treble);
                }
                if (bass < -0.05f) {
                    g += shelfGain(EQ_BANDS[i], 200f, bass);
                }
                curve[i] = Math.max(-JS_GAIN_LIMIT * 1.5f, Math.min(JS_GAIN_LIMIT * 1.5f, g));
            }

            // 设备每个 band 的中心频率处，取曲线在对数频率轴上的线性插值
            for (short band = 0; band < bands; band++) {
                int center = equalizer.getCenterFreq(band) / 1000; // mHz → Hz
                float gain = interpolateGain(center, curve);
                equalizer.setBandLevel(band, (short) Math.round(gain * scale * 1000f));
            }
            equalizer.setEnabled(enabled);
        } catch (Throwable t) {
            Log.w(TAG, "应用均衡器失败：" + t);
        }
    }

    /**
     * 搁架响应：转折频率以上（正转折）/以下（负转折）全量生效，
     * 对数轴上一个八度内平滑过渡到 0。模拟 analog shelf 的常见近似。
     */
    private static float shelfGain(float freqHz, float cornerHz, float gainDb) {
        double octaves = Math.log(freqHz / cornerHz) / Math.log(2);
        if (gainDb > 0) {
            // 提升搁架：转折点以上全量
            double t = Math.max(0d, Math.min(1d, octaves));
            return (float) (gainDb * t);
        }
        // 衰减搁架：转折点以下全量
        double t = Math.max(0d, Math.min(1d, -octaves));
        return (float) (gainDb * t);
    }

    /**
     * 对数频率轴插值：JS 十段是等比数列（每段 ×2），设备 band 中心频率落在
     * 哪两段之间就按对数距离加权，落在两端之外取端点值。
     */
    private static float interpolateGain(float freqHz, float[] gains) {
        if (freqHz <= EQ_BANDS[0]) {
            return gains[0];
        }
        int last = EQ_BANDS.length - 1;
        if (freqHz >= EQ_BANDS[last]) {
            return gains[last];
        }
        for (int i = 0; i < last; i++) {
            float lo = EQ_BANDS[i];
            float hi = EQ_BANDS[i + 1];
            if (freqHz >= lo && freqHz <= hi) {
                // 对数轴上的位置 0..1
                double t = Math.log(freqHz / lo) / Math.log(hi / lo);
                return (float) (gains[i] + (gains[i + 1] - gains[i]) * t);
            }
        }
        return 0f;
    }

    /** 低音增强：BassBoost 只能"加"不能"减"，负值交给 EQ 低频段；强度 0..1000 */
    private void applyBass(JSONObject params, boolean enabled) {
        if (bassBoost == null) {
            return;
        }
        try {
            float bass = (float) params.optDouble("bass", 0d);
            boolean on = enabled && bass > 0.05f;
            bassBoost.setStrength((short) Math.round(Math.min(1f, bass / JS_GAIN_LIMIT) * 1000f));
            bassBoost.setEnabled(on);
        } catch (Throwable t) {
            Log.w(TAG, "应用低音增强失败：" + t);
        }
    }

    /** 环绕声：Virtualizer strength 0..1000（Android 侧只有加宽，负值按 0 处理） */
    private void applyVirtualizer(JSONObject params, boolean enabled) {
        if (virtualizer == null) {
            return;
        }
        try {
            float strength = (float) params.optDouble("surroundStrength", 0d);
            boolean on = enabled && strength > 0.02f;
            virtualizer.setStrength((short) Math.round(Math.min(1f, Math.max(0f, strength)) * 1000f));
            virtualizer.setEnabled(on);
        } catch (Throwable t) {
            Log.w(TAG, "应用环绕声失败：" + t);
        }
    }

    /**
     * 环境音效：预设名 → EnvironmentalReverb 参数。
     * 混响输出 = 干声 + 湿尾（插入式），reverbLevel 控制湿度。
     * surroundDepth（0..1）映射到早期反射延迟与房间尺寸，做纵深感。
     */
    private void applyReverb(JSONObject params, boolean enabled) {
        if (reverb == null) {
            return;
        }
        try {
            String name = params.optString("reverb", "无");
            float depth = (float) params.optDouble("surroundDepth", 0d);
            boolean on = enabled && !"无".equals(name);
            if (!on) {
                reverb.setEnabled(false);
                return;
            }
            ReverbPreset p = ReverbPreset.byName(name);
            reverb.setRoomLevel(p.roomLevelDb);
            reverb.setRoomHFLevel(p.roomHFLevelDb);
            reverb.setDecayTime(p.decayMs);
            reverb.setDecayHFRatio((short) Math.round(p.decayHFRatio * 1000f));
            reverb.setReflectionsLevel(p.reflectionsLevelDb);
            // 深度：早期反射延迟 0~90ms，听感是"房间更深"
            reverb.setReflectionsDelay(Math.round(p.reflectionsDelayMs + depth * 90f));
            reverb.setReverbLevel(p.reverbLevelDb);
            reverb.setReverbDelay(p.reverbDelayMs);
            reverb.setDiffusion((short) Math.round(p.diffusion * 1000f));
            reverb.setDensity((short) Math.round(p.density * 1000f));
            reverb.setEnabled(true);
        } catch (Throwable t) {
            Log.w(TAG, "应用环境音效失败：" + t);
        }
    }

    /** 是否有任一效果开启（offload 联动用）：直通模式下系统 DSP 不参与，音效会失效 */
    synchronized boolean isAnyEnabled() {
        return anyEnabled;
    }

    /** 当前状态快照（getState 汇总用） */
    synchronized String describe() {
        return "{\"sessionId\":" + sessionId
            + ",\"eq\":" + eqSupported
            + ",\"bass\":" + bassSupported
            + ",\"virtualizer\":" + virtSupported
            + ",\"reverb\":" + reverbSupported
            + ",\"lastApplied\":" + lastAppliedJson + "}";
    }

    /**
     * 环境音效预设：名字与 JS 侧 REVERB_PRESETS 同表。
     * 参数取自网易云混响参数表的量级（房间/衰减/湿度），按 EnvironmentalReverb
     * 的参数域改写——数值单位是毫秒/分贝/千分比。
     */
    private enum ReverbPreset {
        BATHROOM("浴室", -6000, -1000, 500, 1.0f, -6000, 20, -2000, 60, 0.6f, 0.5f),
        ROOM("房间", -5000, -500, 700, 1.0f, -4000, 15, -1600, 70, 0.6f, 0.5f),
        TUNNEL("地下通道", -2000, -300, 1600, 0.8f, -2500, 40, -1000, 90, 0.9f, 0.9f),
        VOCAL_PLATE("声乐板", -3000, 0, 1100, 0.9f, -3000, 25, -1200, 40, 1.0f, 0.8f),
        SPRING("弹簧", -2500, -500, 1900, 0.7f, -3000, 30, -1200, 50, 0.8f, 0.6f),
        CONCERT_HALL("音乐厅", -2500, -200, 2400, 0.7f, -3000, 35, -800, 80, 0.85f, 0.85f),
        CHURCH("教堂", -2000, -100, 3400, 0.6f, -3500, 45, -600, 100, 0.95f, 1.0f),
        HALL("大厅", -2200, -200, 3000, 0.65f, -3200, 40, -700, 90, 0.9f, 0.9f),
        LIVE("演唱会", -2600, -200, 2600, 0.7f, -2800, 30, -900, 70, 0.85f, 0.8f),
        CLUB("夜店", -2600, -300, 2000, 0.75f, -2600, 25, -1000, 60, 0.8f, 0.75f);

        final String name;
        final short roomLevelDb;
        final short roomHFLevelDb;
        final int decayMs;
        final float decayHFRatio;
        final short reflectionsLevelDb;
        final int reflectionsDelayMs;
        final short reverbLevelDb;
        final int reverbDelayMs;
        final float diffusion;
        final float density;

        ReverbPreset(String name, int roomLevel, int roomHF, int decayMs, float decayHF,
                     int reflLevel, int reflDelay, int reverbLevel, int reverbDelay,
                     float diffusion, float density) {
            this.name = name;
            this.roomLevelDb = (short) roomLevel;
            this.roomHFLevelDb = (short) roomHF;
            this.decayMs = decayMs;
            this.decayHFRatio = decayHF;
            this.reflectionsLevelDb = (short) reflLevel;
            this.reflectionsDelayMs = reflDelay;
            this.reverbLevelDb = (short) reverbLevel;
            this.reverbDelayMs = reverbDelay;
            this.diffusion = diffusion;
            this.density = density;
        }

        static ReverbPreset byName(String name) {
            for (ReverbPreset p : values()) {
                if (p.name.equals(name)) {
                    return p;
                }
            }
            return ROOM;
        }
    }
}
