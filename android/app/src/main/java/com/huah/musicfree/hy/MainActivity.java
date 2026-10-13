package com.huah.musicfree.hy;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

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

        setupWebViewRendererPriority();
    }

    /**
     * 音频本体在原生 ExoPlayer，但换歌预加载 / 播完簿记 / 断流自救都靠 WebView 里的
     * JS 驱动。WebView 默认 renderer 策略是 RENDERER_PRIORITY_IMPORTANT +
     * waivedWhenNotVisible=true——页面一退后台渲染进程就进系统「可冻结」名单，
     * 内存吃紧或后台时间一长就被冻结，JS 整体停摆：结尾 30 秒的 appendNextSource
     * 预加载没发生，ExoPlayer 播完当前曲进 STATE_ENDED 就静音了，表现为
     * 「后台播着播着自己停，重进 app 才继续」。关掉 waive 让渲染进程保持
     * IMPORTANT 优先级，前台服务 + 唤醒锁继续负责不让进程被杀。
     */
    private void setupWebViewRendererPriority() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return;
        }
        try {
            WebView webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView != null) {
                // RENDERER_PRIORITY_IMPORTANT = 1（android.webkit.RendererPriority
                // 在部分 compileSdk 下不可见，直接用文档常量值）
                webView.setRendererPriorityPolicy(1, false);
            }
        } catch (Exception e) {
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
