package com.huah.musicfree.hy;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * 应用检查更新插件：读安装包版本 → 定更新包保存路径 → 拉起系统安装器。
 *
 * 版本清单 JSON 与 APK 放在缤纷云 S4 桶（CDN 直链），拉取与下载都在 JS 侧完成
 * （清单走 netFetchText，APK 复用 StoragePlugin 的直落磁盘下载通道），本插件只做
 * JS 侧做不到的三件事：读 PackageInfo、算应用私有目录路径、经 FileProvider 发装包 Intent。
 *
 * 与 LocalMusicPlugin / StoragePlugin 同模式：JS 侧经 bridge 的 nativePromise 调用，
 * 不打包插件 JS 运行时；方法跑在 CapacitorPlugins 工作线程，发 Intent 需 NEW_TASK 标记。
 */
@CapacitorPlugin(name = "AppUpdate")
public class UpdatePlugin extends Plugin {

    /** 更新包在应用私有目录下的子目录名（卸载即清，不污染公共目录） */
    private static final String UPDATE_DIR = "update";
    /** 安装包文件名前缀：带版本号，隔离新旧包的 .part 续传残留 */
    private static final String APK_PREFIX = "MusicFreeHy-";

    /** 本机安装包版本（versionCode 为更新比较的唯一权威，versionName 仅展示） */
    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            Context context = getContext();
            PackageInfo info = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            JSObject res = new JSObject();
            res.put("versionCode", Build.VERSION.SDK_INT >= 28
                ? info.getLongVersionCode()
                : info.versionCode);
            res.put("versionName", info.versionName);
            // 更新渠道：debug 构建的 applicationId 带 ".debug" 后缀（build.gradle），
            // JS 按它决定拉哪条版本清单（update-debug.json / update.json）——
            // 正式渠道与 debug 渠道互不提示对方的更新包
            res.put("packageName", context.getPackageName());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("读取版本信息失败");
        }
    }

    /** 更新包保存路径：getExternalFilesDir/update/MusicFreeHy-<versionName>.apk（顺带建目录） */
    @PluginMethod
    public void getApkSavePath(PluginCall call) {
        String versionName = call.getString("versionName");
        if (versionName == null || versionName.trim().isEmpty()) {
            call.reject("缺少版本号");
            return;
        }
        File dir = new File(getContext().getExternalFilesDir(null), UPDATE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            call.reject("无法创建更新包目录");
            return;
        }
        JSObject res = new JSObject();
        res.put("path", new File(dir, APK_PREFIX + versionName.trim() + ".apk").getAbsolutePath());
        call.resolve(res);
    }

    /** 是否已获「安装未知应用」授权（前端在授权页返回后预检，决定要不要自动续装） */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT >= 26
            ? getContext().getPackageManager().canRequestPackageInstalls()
            : true;
        JSObject res = new JSObject();
        res.put("granted", granted);
        call.resolve(res);
    }

    /**
     * 拉起系统安装器。Android 8+ 先要「允许安装未知应用」授权：没有时跳系统授权页并
     * resolve { needPermission: true }，用户授权返回后再点一次「立即安装」即走安装分支。
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少安装包路径");
            return;
        }
        File apk = new File(path.trim());
        if (!apk.isFile()) {
            call.reject("安装包不存在，请重新下载");
            return;
        }
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
            openUnknownSourceSettings(context);
            JSObject res = new JSObject();
            res.put("needPermission", true);
            call.resolve(res);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(context,
                context.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法启动安装：" + e.getMessage());
        }
    }

    /** 「允许安装未知应用」授权页；个别 ROM 没有该入口时退到应用详情页 */
    private static void openUnknownSourceSettings(Context context) {
        String pkg = context.getPackageName();
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(Uri.parse("package:" + pkg));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Exception ignored) {
                // 连应用详情都没有：保持 resolve(needPermission)，用户手动去设置
            }
        }
    }
}
