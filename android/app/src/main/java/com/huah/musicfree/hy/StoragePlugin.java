package com.huah.musicfree.hy;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * 存储访问插件：文件夹浏览（含音频计数）+ 绝对路径写入 / 删除 / 可写探针，
 * 供「下载保存位置」与「本地音乐扫描目录」的文件夹选择页使用。
 *
 * 为什么不走 Filesystem 插件：
 *  - 它对公共目录（ExternalStorage / Documents）自带运行时权限门禁，走
 *    READ_EXTERNAL_STORAGE，Android 13+ 上已被 READ_MEDIA_AUDIO 取代，申请必被拒；
 *  - 这里直接用 java.io.File，权限由本插件按系统版本自己管：
 *      Android 11+：「所有文件访问」（MANAGE_EXTERNAL_STORAGE，跳系统设置页授权），
 *        没有它浏览公共目录依旧可行（有 READ_MEDIA_AUDIO 时可列目录、读媒体文件），
 *        但写入 / 删除会被系统拦；
 *      Android 9~10：WRITE_EXTERNAL_STORAGE（配 manifest 的 requestLegacyExternalStorage）。
 *    授权状态不在这里卡流程，浏览失败原样拒绝，可写性由 canWrite 探针给 JS 判断。
 *
 * 与 LocalMusicPlugin / MediaNotificationPlugin 同模式：JS 侧经 bridge 的
 * nativePromise 调用，不打包插件 JS 运行时。
 */
@CapacitorPlugin(
    name = "Storage",
    permissions = {
        // Android 9 及以下读写一起要；Android 10 靠 legacy 标记 + 写权限
        @Permission(
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE },
            alias = "storageLegacy"
        )
    }
)
public class StoragePlugin extends Plugin {

    private static final String[] AUDIO_EXTS = {
        "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "wma", "ape"
    };
    /** 探针文件名（点开头，浏览列表与文件管理器都不展示） */
    private static final String PROBE_NAME = ".mf-write-probe";

    private static boolean hasAudioExt(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return false;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.US);
        for (String e : AUDIO_EXTS) {
            if (e.equals(ext)) {
                return true;
            }
        }
        return false;
    }

    /* ---------- 根目录 ---------- */

    @PluginMethod
    public void getStorageRoot(PluginCall call) {
        JSObject res = new JSObject();
        res.put("path", Environment.getExternalStorageDirectory().getAbsolutePath());
        call.resolve(res);
    }

    /* ---------- 权限 ---------- */

    /** 授权状态速查：allFiles（浏览+任意写）与 audioRead（媒体文件读取） */
    @PluginMethod
    public void checkAccess(PluginCall call) {
        JSObject res = new JSObject();
        res.put("allFiles", hasAllFilesAccess());
        res.put("audioRead", hasAudioReadPermission());
        call.resolve(res);
    }

    /** 写入前授权：Android 11+ 需要「所有文件访问」；低版本走运行时权限弹窗 */
    @PluginMethod
    public void requestWritePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 30) {
            boolean granted = Environment.isExternalStorageManager();
            JSObject res = new JSObject();
            res.put("granted", granted);
            res.put("needAllFiles", !granted);
            call.resolve(res);
            return;
        }
        Context c = getContext();
        if (c.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED) {
            call.resolve(grantedResult(true, false));
            return;
        }
        try {
            requestPermissionForAlias("storageLegacy", call, "onWritePermissionResult");
        } catch (Exception e) {
            e.printStackTrace();
            call.resolve(grantedResult(false, false));
        }
    }

    @PermissionCallback
    private void onWritePermissionResult(PluginCall call) {
        boolean granted = getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
        call.resolve(grantedResult(granted, false));
    }

    /** 「所有文件访问」系统设置页（Android 11+；授权后用户返回，JS 用 checkAccess 复查） */
    @PluginMethod
    public void openAllFilesAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            call.resolve(grantedResult(true, false));
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve(grantedResult(false, true));
        } catch (Exception e) {
            // 个别 ROM 没有该入口，退到总设置
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_SETTINGS));
                call.resolve(grantedResult(false, true));
            } catch (Exception ignored) {
                call.resolve(grantedResult(false, false));
            }
        }
    }

    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            return Environment.isExternalStorageManager();
        }
        return getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAudioReadPermission() {
        Context c = getContext();
        String perm = Build.VERSION.SDK_INT >= 33
            ? Manifest.permission.READ_MEDIA_AUDIO
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        return c.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject grantedResult(boolean granted, boolean needAllFiles) {
        JSObject res = new JSObject();
        res.put("granted", granted);
        res.put("needAllFiles", needAllFiles);
        return res;
    }

    /* ---------- 文件夹浏览 ---------- */

    /**
     * 列出目录下的子文件夹（不含隐藏目录），带直接子级音频数量。
     * path 传空表示存储根目录；目录不可读时拒绝（含权限原因提示）。
     */
    @PluginMethod
    public void listDirs(PluginCall call) {
        String path = call.getString("path", "");
        File dir = path == null || path.trim().isEmpty()
            ? Environment.getExternalStorageDirectory()
            : new File(path.trim());
        if (!dir.isDirectory()) {
            call.reject("目录不存在：" + dir.getAbsolutePath());
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            call.reject(hasAudioReadPermission()
                ? "无法读取该目录"
                : "无法读取该目录（缺少存储读取权限）");
            return;
        }
        JSArray dirs = new JSArray();
        for (File child : children) {
            String name = child.getName();
            if (!child.isDirectory() || name.startsWith(".")) {
                continue;
            }
            JSObject item = new JSObject();
            item.put("name", name);
            item.put("audioCount", countAudioFiles(child));
            dirs.put(item);
        }
        JSObject res = new JSObject();
        res.put("path", dir.getAbsolutePath());
        res.put("dirs", dirs);
        call.resolve(res);
    }

    /** 直接子级里的音频文件数（不递归，浏览页展示用） */
    private static int countAudioFiles(File dir) {
        File[] children = dir.listFiles();
        if (children == null) {
            return 0;
        }
        int count = 0;
        for (File child : children) {
            if (child.isFile() && hasAudioExt(child.getName())) {
                count += 1;
            }
        }
        return count;
    }

    /* ---------- 可写探针 ---------- */

    /** 试写一个探针文件再删掉，顺带 mkdirs 目标目录；writable=false 时带原因 */
    @PluginMethod
    public void canWrite(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少目录路径");
            return;
        }
        File dir = new File(path.trim());
        String reason = null;
        try {
            if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
                reason = "无法创建该文件夹";
            } else {
                File probe = new File(dir, PROBE_NAME);
                try (OutputStream out = new FileOutputStream(probe)) {
                    out.write('o');
                    out.write('k');
                }
                if (!probe.delete() && probe.exists()) {
                    reason = "探针文件删除失败";
                }
            }
        } catch (Exception e) {
            reason = hasAllFilesAccess() || Build.VERSION.SDK_INT < 30
                ? "该文件夹不可写"
                : "该文件夹不可写（需要「所有文件访问」权限）";
        }
        JSObject res = new JSObject();
        res.put("writable", reason == null);
        if (reason != null) {
            res.put("reason", reason);
        }
        call.resolve(res);
    }

    /* ---------- 写入 / 删除 ---------- */

    /** 创建文件夹（已存在视为成功） */
    @PluginMethod
    public void mkdir(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少目录路径");
            return;
        }
        File dir = new File(path.trim());
        if (dir.isDirectory() || dir.mkdirs()) {
            call.resolve();
            return;
        }
        boolean needAllFiles = Build.VERSION.SDK_INT >= 30 && !hasAllFilesAccess();
        call.reject(needAllFiles
            ? "创建失败（需要「所有文件访问」权限）"
            : "创建失败");
    }

    /**
     * 绝对路径分块写入（base64）：首块建文件，后续 append。
     * 与 JS 侧下载通道的 3MB 分块约定一致。
     */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String path = call.getString("path");
        String data = call.getString("data");
        boolean append = Boolean.TRUE.equals(call.getBoolean("append"));
        if (path == null || path.trim().isEmpty() || data == null) {
            call.reject("缺少写入参数");
            return;
        }
        File file = new File(path.trim());
        try {
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                call.reject("无法创建目标文件夹");
                return;
            }
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            try (OutputStream out = new FileOutputStream(file, append)) {
                out.write(bytes);
            }
            call.resolve();
        } catch (Exception e) {
            boolean needAllFiles = Build.VERSION.SDK_INT >= 30 && !hasAllFilesAccess();
            call.reject(needAllFiles
                ? "写入失败（需要「所有文件访问」权限）"
                : "写入失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        File file = new File(path.trim());
        boolean deleted = !file.exists() || file.delete();
        JSObject res = new JSObject();
        res.put("deleted", deleted);
        call.resolve(res);
    }
}
