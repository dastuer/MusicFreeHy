package com.huah.musicfree.hy;

import android.Manifest;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 播放通知插件：WebView 里的播放器（JS）与系统媒体通知（原生）之间的桥。
 *
 * JS → 原生：
 *  - updateMetadata：歌曲元数据（标题 / 歌手 / 专辑 / 封面 / 时长）
 *  - updatePlayback：播放状态（是否播放中 / 进度 / 倍速）
 *  - stop：收起通知并停掉前台服务
 *  - ensurePermission：Android 13+ 的通知权限（其余系统视为已授予）
 *
 * 原生 → JS：通知按钮、耳机线控等媒体控制以「action」事件回传，
 * 动作名见 MediaPlaybackService 的 ACTION_* 常量（与 mediaNotification.ts 对齐）。
 */
@CapacitorPlugin(
    name = "MediaNotification",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class MediaNotificationPlugin extends Plugin {

    private static final String PERMISSION_ALIAS = "notifications";

    @Override
    public void load() {
        MediaPlaybackService.setActionListener((action, position) -> {
            JSObject data = new JSObject();
            data.put("action", action);
            if (position > 0) {
                data.put("position", position);
            }
            notifyListeners("action", data);
        });
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        MediaPlaybackService.updateMetadata(
            getContext(),
            call.getString("title", ""),
            call.getString("artist", ""),
            call.getString("album", ""),
            call.getString("artwork", ""),
            call.getDouble("duration", 0d)
        );
        call.resolve();
    }

    @PluginMethod
    public void updatePlayback(PluginCall call) {
        MediaPlaybackService.updatePlayback(
            getContext(),
            Boolean.TRUE.equals(call.getBoolean("playing")),
            call.getDouble("position", 0d),
            call.getDouble("rate", 1d),
            call.getDouble("duration", 0d)
        );
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MediaPlaybackService.stop(getContext());
        call.resolve();
    }

    /** Android 13+ 需要通知权限才能挂通知；低版本直接视为已授予 */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || isNotificationGranted()) {
            call.resolve(grantedResult(true));
            return;
        }
        try {
            requestPermissionForAlias(PERMISSION_ALIAS, call, "onPermissionResult");
        } catch (Exception e) {
            // 别因权限请求失败挡住播放
            e.printStackTrace();
            call.resolve(grantedResult(false));
        }
    }

    @PermissionCallback
    private void onPermissionResult(PluginCall call) {
        call.resolve(grantedResult(isNotificationGranted()));
    }

    private boolean isNotificationGranted() {
        PermissionState state = getPermissionState(PERMISSION_ALIAS);
        return state == PermissionState.GRANTED;
    }

    private JSObject grantedResult(boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        return result;
    }
}
