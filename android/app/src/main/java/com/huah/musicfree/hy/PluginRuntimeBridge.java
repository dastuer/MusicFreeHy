package com.huah.musicfree.hy;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生插件运行时桥（WebView JS → QuickJS）
 *
 * 只有两件事：
 *  1. syncPlugins：把已启用插件的源码快照推给原生（原生落盘 + 挂载），
 *     这样 JS 被冻结/被杀之后，MediaPlaybackService 仍能自己跑 getMediaSource；
 *  2. resolveMediaSource：同步暴露给 JS 用（调试/兜底；正常播放链路是服务侧直连 PluginRuntime）。
 */
@CapacitorPlugin(name = "PluginRuntime")
public class PluginRuntimeBridge extends Plugin {

    /** 解析是阻塞调用：桥方法不能占用 bridge 线程（WebView 可能正等着 JS 回来） */
    private final ExecutorService io = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "plugin-runtime-bridge");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("ready", PluginRuntime.getInstance(getContext()).isReady());
        call.resolve(ret);
    }

    /** 插件源码快照同步：[{hash, code, userVariables}, ...]（与原生挂载顺序一致） */
    @PluginMethod
    public void syncPlugins(PluginCall call) {
        JSArray plugins = call.getArray("plugins");
        String json = plugins == null ? "[]" : plugins.toString();
        if (json.isEmpty()) {
            json = "[]";
        }
        PluginRuntime.getInstance(getContext()).syncPlugins(json);
        call.resolve();
    }

    /** 主动解析一次音源（调试/兜底用；播放链路由服务侧直连 PluginRuntime） */
    @PluginMethod
    public void resolveMediaSource(PluginCall call) {
        String musicItemJson = call.getString("musicItemJson");
        if (musicItemJson == null || musicItemJson.isEmpty()) {
            JSObject item = call.getObject("musicItem");
            if (item != null) {
                musicItemJson = item.toString();
            }
        }
        if (musicItemJson == null || musicItemJson.isEmpty()) {
            call.reject("musicItem is required");
            return;
        }
        final String itemJson = musicItemJson;
        final String quality = call.getString("quality", "standard");
        final String excludeUrl = call.getString("excludeUrl", "");
        final long timeoutMs = call.getLong("timeoutMs",
            PluginRuntime.DEFAULT_RESOLVE_TIMEOUT_MS);
        io.execute(() -> {
            String res = PluginRuntime.getInstance(getContext())
                .resolve(itemJson, quality, excludeUrl, timeoutMs);
            try {
                call.resolve(new JSObject(res));
            } catch (Exception e) {
                call.reject("解析结果解析失败：" + e.getMessage());
            }
        });
    }
}
