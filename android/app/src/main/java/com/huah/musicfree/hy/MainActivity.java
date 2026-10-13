package com.huah.musicfree.hy;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity.onCreate 里就会构建 bridge，
        // 之后再 registerPlugin 就加不进去了
        registerPlugin(MediaNotificationPlugin.class);
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(StoragePlugin.class);
        registerPlugin(NativeAudioPlugin.class);
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // WebView 就绪后再钉渲染进程策略（getBridge 在 super.onCreate 后才有值）
        pinWebViewRenderer();
    }

    /**
     * 后台 JS 保活（根治「切后台无法加载下一首 / 通知栏切歌失灵」）：
     *
     * WebView 不可见时，默认的渲染进程优先级策略（IMPORTANT + 不可见即 waive）
     * 会把渲染进程降级，Chromium 随之冻结/回收它——整个播放控制面都在页面 JS 里：
     * 曲终换歌的预加载、音源解析 Worker、通知栏与耳机动作的转发，全部随之停摆。
     *
     * 显式改成 IMPORTANT 且不可见也不 waive，配合 Capacitor 默认的 KeepRunning
     * （不退后台就 pauseTimers）与播放前台服务，页面 JS 在后台持续运行。
     * 音频本体在 ExoPlayer（原生）里，本条只关「JS 是否还能跑」。
     */
    private void pinWebViewRenderer() {
        // setRendererPriorityPolicy 是 API 26+；minSdk 24 的老机器没有它，跳过即可
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            Bridge bridge = getBridge();
            WebView webView = bridge == null ? null : bridge.getWebView();
            if (webView != null) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
        } catch (Throwable e) {
            // 个别 ROM 的 WebView 实现不认这个策略：退化为默认行为，不影响播放
            e.printStackTrace();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // 本地音乐：系统删除确认框（MediaStore.createDeleteRequest）的结果回传
        LocalMusicPlugin.dispatchDeleteResult(requestCode, resultCode);
    }
}
