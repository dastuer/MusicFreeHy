package com.huah.musicfree.hy;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

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

    /** 文件存在性与大小（播放缓存命中时校验文件是否仍在，不涉及权限敏感目录） */
    @PluginMethod
    public void statFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        File file = new File(path.trim());
        JSObject res = new JSObject();
        res.put("exists", file.exists());
        res.put("size", file.length());
        res.put("isDirectory", file.isDirectory());
        call.resolve(res);
    }

    /* ---------- 原生直落磁盘下载 ---------- */

    /**
     * 「HTTP 拉流 + 写盘」整体在原生线程完成（docs/native-download.md）：
     * 下载字节完全不过 JS 桥，5 路并发也不占用 WebView 主线程；
     * 进度经 downloadProgress 事件回传（小 JSON，~200ms 节流），与分块过桥的
     * writeFile 通道并存 —— 后者保留作回退与播放缓存使用。
     */

    /** 下载临时文件后缀（destPath + ".part"），失败/暂停保留供续传 */
    private static final String PART_SUFFIX = ".part";
    /** 进度事件节流间隔 */
    private static final long PROGRESS_INTERVAL_MS = 200;
    /** 连接 / 读取超时（与 JS 侧分块下载现状一致） */
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    /** 重定向跟随上限（对齐 nativeHttpRequest 的语义） */
    private static final int MAX_REDIRECT_HOPS = 10;

    /**
     * 进行中的下载会话：cancelDownload 靠 taskId 找到当前连接与流去中断。
     * HttpURLConnection 不跟随 https→http 跨协议重定向（网易直链 302 正是这种），
     * 与 CapacitorHttp 一样的坑，在下载线程里手动跟随，会话里始终是当前那一跳。
     */
    private static final class DownloadSession {
        volatile HttpURLConnection connection;
        volatile boolean cancelled;
    }

    /** taskId → 进行中会话 */
    private final ConcurrentHashMap<String, DownloadSession> downloadSessions = new ConcurrentHashMap<>();
    /** 下载线程池（5 路并发 = 5 个工作线程，守护线程随进程退出） */
    private ExecutorService downloadExecutor;

    private synchronized ExecutorService downloadExecutor() {
        if (downloadExecutor == null) {
            downloadExecutor = Executors.newCachedThreadPool(task -> {
                Thread thread = new Thread(task, "mf-download");
                thread.setDaemon(true);
                return thread;
            });
        }
        return downloadExecutor;
    }

    /**
     * 直落磁盘下载：流式写 destPath（先写 destPath + ".part"，成功后改名）。
     * 参数: { taskId, url, headers, destPath }；成功 resolve { path, size, contentType }，
     * 失败 reject（.part 保留供续传）。
     */
    @PluginMethod
    public void downloadFile(PluginCall call) {
        String taskId = call.getString("taskId");
        String url = call.getString("url");
        String destPath = call.getString("destPath");
        if (taskId == null || taskId.trim().isEmpty()
            || url == null || url.trim().isEmpty()
            || destPath == null || destPath.trim().isEmpty()) {
            call.reject("缺少下载参数");
            return;
        }
        String tid = taskId.trim();
        if (downloadSessions.containsKey(tid)) {
            call.reject("该任务已在下载中");
            return;
        }
        try {
            // 目录创建也放进下载线程：mkdirs 是磁盘 IO，别卡 WebView 主线程
            downloadExecutor().execute(() ->
                runDownload(call, tid, url.trim(), parseHeaders(call),
                    new File(destPath.trim()), new File(destPath.trim() + PART_SUFFIX)));
        } catch (RejectedExecutionException e) {
            call.reject("下载服务不可用");
        }
    }

    /** 中断指定 taskId 的下载（保留 .part 供续传）；任务不存在也 resolve（幂等） */
    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId != null) {
            DownloadSession session = downloadSessions.get(taskId.trim());
            if (session != null) {
                cancelSession(session);
            }
        }
        JSObject res = new JSObject();
        res.put("cancelled", true);
        call.resolve(res);
    }

    private static void cancelSession(DownloadSession session) {
        session.cancelled = true;
        HttpURLConnection conn = session.connection;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignore) {
                // 连接已断开
            }
        }
        // 注意：这里绝不能去 close 另一个线程正在 read 的流 —— Android 的
        // HttpURLConnection 内部是 okhttp/okio 实现，跨线程 close 与读线程的
        // AsyncTimeout 状态机竞态会抛 "Unbalanced enter/exit" 直接崩掉进程
        // （disconnect 断开底层 socket 后，读线程自己会收到 IOException 走收尾）。
    }

    private static Map<String, String> parseHeaders(PluginCall call) {
        Map<String, String> headers = new LinkedHashMap<>();
        JSObject obj = call.getObject("headers");
        if (obj != null) {
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = obj.opt(key);
                if (value != null && String.valueOf(value).length() > 0) {
                    headers.put(key, String.valueOf(value));
                }
            }
        }
        return headers;
    }

    private void runDownload(PluginCall call, String taskId, String url,
                             Map<String, String> headers, File dest, File part) {
        DownloadSession session = new DownloadSession();
        downloadSessions.put(taskId, session);
        try {
            File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                call.reject("无法创建目标文件夹");
                return;
            }
            long partSize = part.exists() ? part.length() : 0;
            Attempt attempt = attemptDownload(session, taskId, url, headers, dest, part, partSize);
            if (attempt.status == 416) {
                // 续传请求被拒（.part 已完整或超界）：已达总长直接收尾，否则丢弃 .part 整包重下一次
                if (attempt.rangeTotal > 0 && partSize == attempt.rangeTotal) {
                    call.resolve(finishDownload(dest, part, attempt.contentType));
                    return;
                }
                if (!part.delete() && part.exists()) {
                    call.reject("无法重置下载临时文件");
                    return;
                }
                attempt = attemptDownload(session, taskId, url, headers, dest, part, 0);
            }
            if (attempt.result == null) {
                call.reject("下载失败");
                return;
            }
            // 正常完成：.part 原子改名成目标文件（改名失败视为下载失败，让调用方重试，
            // 字节仍在 .part 里可续传——绝不能把「字节还没落到位」当成成功上报）
            call.resolve(finishDownload(dest, part, attempt.contentType));
        } catch (IOException e) {
            if (session.cancelled) {
                call.reject("下载已取消");
            } else {
                call.reject(e.getMessage() == null ? "下载失败" : e.getMessage());
            }
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "下载失败" : e.getMessage());
        } finally {
            downloadSessions.remove(taskId);
        }
    }

    /** 一次请求的产物：正常完成带 result；416 时只有状态与总长（由调用方决定重下还是收尾） */
    private static final class Attempt {
        final int status;
        final long rangeTotal;
        final String contentType;
        final JSObject result;

        Attempt(int status, long rangeTotal, String contentType) {
            this.status = status;
            this.rangeTotal = rangeTotal;
            this.contentType = contentType;
            this.result = null;
        }

        Attempt(JSObject result, String contentType) {
            this.status = 200;
            this.rangeTotal = -1;
            this.contentType = contentType;
            this.result = result;
        }
    }

    /** 发起一次下载并流式写盘（手动跟随重定向，含跨协议）；响应码交由调用方处理的只有 416 */
    private Attempt attemptDownload(DownloadSession session, String taskId, String url,
                                    Map<String, String> headers, File dest, File part,
                                    long partSize) throws IOException {
        String currentUrl = url;
        HttpURLConnection conn = null;
        for (int hop = 0; ; hop++) {
            if (session.cancelled) {
                throw new IOException("下载已取消");
            }
            HttpURLConnection request = (HttpURLConnection) new URL(currentUrl).openConnection();
            request.setConnectTimeout(CONNECT_TIMEOUT_MS);
            request.setReadTimeout(READ_TIMEOUT_MS);
            request.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> header : headers.entrySet()) {
                request.setRequestProperty(header.getKey(), header.getValue());
            }
            // 关掉透明 gzip：进度按解压后字节算会与 Content-Length 错位（调用方自带时以调用方为准）
            if (!headers.containsKey("Accept-Encoding")) {
                request.setRequestProperty("Accept-Encoding", "identity");
            }
            if (partSize > 0) {
                request.setRequestProperty("Range", "bytes=" + partSize + "-");
            }
            session.connection = request;
            int status = request.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = request.getHeaderField("Location");
                request.disconnect();
                if (location == null || location.trim().isEmpty()) {
                    throw new IOException("请求失败 (" + status + ")");
                }
                if (hop >= MAX_REDIRECT_HOPS) {
                    throw new IOException("重定向次数过多");
                }
                currentUrl = new URL(new URL(currentUrl), location.trim()).toString();
                continue;
            }
            conn = request;
            break;
        }

        int status = conn.getResponseCode();
        String contentType = conn.getHeaderField("Content-Type");
        if (status == 416 && partSize > 0) {
            long rangeTotal = parseRangeTotal(conn.getHeaderField("Content-Range"));
            conn.disconnect();
            return new Attempt(status, rangeTotal, contentType);
        }
        if (status >= 400) {
            conn.disconnect();
            throw new IOException("请求失败 (" + status + ")");
        }

        // 206 且起点与 .part 对上才追加；否则（200 不支持 Range / 起点漂移 / 全新下载）从头整包写
        long rangeTotal = -1;
        boolean append = false;
        if (status == 206 && partSize > 0) {
            String contentRange = conn.getHeaderField("Content-Range");
            long rangeStart = parseRangeStart(contentRange);
            rangeTotal = parseRangeTotal(contentRange);
            if (rangeStart == partSize) {
                append = true;
            }
        }
        long total = -1;
        if (append) {
            total = rangeTotal;
        } else {
            long contentLength = conn.getContentLengthLong();
            total = contentLength > 0 ? contentLength : -1;
        }
        long loaded = append ? partSize : 0;

        InputStream in = null;
        OutputStream out = null;
        try {
            in = conn.getInputStream();
            out = new FileOutputStream(part, append);
            byte[] buffer = new byte[64 * 1024];
            long lastNotifyAt = 0;
            int n;
            while ((n = in.read(buffer)) != -1) {
                if (session.cancelled) {
                    throw new IOException("下载已取消");
                }
                out.write(buffer, 0, n);
                loaded += n;
                long now = SystemClock.elapsedRealtime();
                if (now - lastNotifyAt >= PROGRESS_INTERVAL_MS) {
                    lastNotifyAt = now;
                    notifyDownloadProgress(taskId, loaded, total);
                }
            }
            out.flush();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignore) {
                    // 保 .part 供续传
                }
            }
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignore) {
                    // 连接即将断开
                }
            }
        }
        conn.disconnect();
        if (session.cancelled) {
            throw new IOException("下载已取消");
        }
        JSObject res = new JSObject();
        res.put("path", dest.getAbsolutePath());
        res.put("size", dest.length());
        if (contentType != null && !contentType.isEmpty()) {
            res.put("contentType", contentType);
        }
        return new Attempt(res, contentType);
    }

    /** .part 原子改名收尾（目标目录与 .part 同盘，rename 不会跨文件系统） */
    private static JSObject finishDownload(File dest, File part, String contentType) throws IOException {
        if (dest.exists() && !dest.delete()) {
            throw new IOException("无法覆盖已存在的文件");
        }
        if (!part.renameTo(dest)) {
            // 个别 ROM 文件系统 rename 受限时退化为复制
            copyFile(part, dest);
            if (!part.delete() && part.exists()) {
                throw new IOException("清理临时文件失败");
            }
        }
        JSObject res = new JSObject();
        res.put("path", dest.getAbsolutePath());
        res.put("size", dest.length());
        if (contentType != null && !contentType.isEmpty()) {
            res.put("contentType", contentType);
        }
        return res;
    }

    private static void copyFile(File src, File dst) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
            }
        }
    }

    /** Content-Range 形如 "bytes 1024-2047/4096"（416 时是 "bytes *\/4096"），解析续传起点 */
    private static long parseRangeStart(String contentRange) {
        if (contentRange == null) {
            return -1;
        }
        int dash = contentRange.indexOf('-');
        int space = contentRange.indexOf(' ');
        if (dash < 0 || space < 0 || dash < space) {
            return -1;
        }
        try {
            return Long.parseLong(contentRange.substring(space + 1, dash).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 解析 Content-Range 的总长（"/" 之后） */
    private static long parseRangeTotal(String contentRange) {
        if (contentRange == null) {
            return -1;
        }
        int slash = contentRange.lastIndexOf('/');
        if (slash < 0 || slash == contentRange.length() - 1) {
            return -1;
        }
        try {
            return Long.parseLong(contentRange.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private void notifyDownloadProgress(String taskId, long loaded, long total) {
        JSObject data = new JSObject();
        data.put("taskId", taskId);
        data.put("loaded", loaded);
        data.put("total", total);
        notifyListeners("downloadProgress", data);
    }
}
