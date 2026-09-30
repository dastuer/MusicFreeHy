package com.huah.musicfree.hy;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity.onCreate 里就会构建 bridge，
        // 之后再 registerPlugin 就加不进去了
        registerPlugin(MediaNotificationPlugin.class);
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(StoragePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // 本地音乐：系统删除确认框（MediaStore.createDeleteRequest）的结果回传
        LocalMusicPlugin.dispatchDeleteResult(requestCode, resultCode);
    }
}
