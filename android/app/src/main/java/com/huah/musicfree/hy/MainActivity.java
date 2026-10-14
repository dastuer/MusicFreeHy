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
        registerPlugin(PlaybackBridge.class);
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(StoragePlugin.class);
        registerPlugin(UpdatePlugin.class);
        registerPlugin(PluginRuntimeBridge.class);
        super.onCreate(savedInstanceState);

        // WebView 就绪后再钉渲染进程策略（getBridge 在 super.onCreate 后才有值）
        pinWebViewRenderer();
    }

    /**
     * 页面 JS 保活：播放本体在原生 ExoPlayer（不依赖 JS），但**队列窗口的
     * 补镜像与缓存本地化依赖 JS 活着**——窗口耗尽前若 JS 复活一次就能续上
     * 下一批窗口。钉 IMPORTANT 且不可见不 waive（部分 ROM 会无视，那是
     * 硬边界），让「能活的设备」尽量活着，与播放内核互为纵深。
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
