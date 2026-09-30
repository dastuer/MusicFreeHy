package com.huah.musicfree.hy;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 本地音乐插件：扫描设备音频文件 + 删除音频文件。
 *
 * 扫描策略（混合，取两边的好处）：
 *  - 先查 MediaStore（快，自带标题/歌手/专辑/时长），按目录前缀过滤；
 *  - 再递归遍历目录补漏（应用私有目录、MediaStore 未收录的文件），
 *    漏网文件用 MediaMetadataRetriever 现场解析元数据与内嵌封面；
 *  - 封面统一落成文件路径（专辑封面从 MediaProvider 拷到应用缓存，
 *    内嵌封面直接写缓存），不回传 base64，记录可以放心进 localStorage。
 *
 * 删除：先直接 File.delete()；失败且系统支持时走 MediaStore 的
 * createDeleteRequest（系统弹确认框，Android 11+ 删除他人媒体文件的正规途径）。
 *
 * 与 MediaNotificationPlugin 同模式：JS 侧经 bridge 的 nativePromise 调用，
 * 不打包插件 JS 运行时。
 */
@CapacitorPlugin(
    name = "LocalMusic",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_MEDIA_AUDIO }, alias = "audio33"),
        @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "audioLegacy"),
        @Permission(
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE },
            alias = "audioLegacyWrite"
        )
    }
)
public class LocalMusicPlugin extends Plugin {

    /** 递归遍历的最大目录深度 */
    private static final int MAX_WALK_DEPTH = 12;
    /** 单次扫描的文件数上限（防御异常目录） */
    private static final int MAX_SCAN_FILES = 20000;
    /** 内嵌封面写缓存的大小上限 */
    private static final int MAX_EMBEDDED_ART_BYTES = 512 * 1024;
    /** 认作音频的扩展名 */
    private static final String[] AUDIO_EXTS = {
        "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "wma", "ape"
    };

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

    private static String extOf(String path) {
        int dot = path.lastIndexOf('.');
        return dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.US) : "";
    }

    private static String nameOf(String path) {
        int slash = path.lastIndexOf('/');
        return slash >= 0 ? path.substring(slash + 1) : path;
    }

    /* ---------- 默认目录 ---------- */

    @PluginMethod
    public void getDefaultDirs(PluginCall call) {
        Context c = getContext();
        JSObject res = new JSObject();
        res.put("downloads", Environment.getExternalStoragePublicDirectory(
            Environment.DIRECTORY_DOWNLOADS).getAbsolutePath());
        res.put("documents", Environment.getExternalStoragePublicDirectory(
            Environment.DIRECTORY_DOCUMENTS).getAbsolutePath());
        res.put("filesDir", c.getFilesDir().getAbsolutePath());
        call.resolve(res);
    }

    /* ---------- 音频读取权限 ---------- */

    @PluginMethod
    public void requestAudioPermission(PluginCall call) {
        if (hasAudioReadPermission()) {
            call.resolve(grantedResult(true));
            return;
        }
        String alias;
        if (Build.VERSION.SDK_INT >= 33) {
            alias = "audio33";
        } else if (Build.VERSION.SDK_INT >= 29) {
            alias = "audioLegacy";
        } else {
            // 旧系统删除文件还需要写权限
            alias = "audioLegacyWrite";
        }
        try {
            requestPermissionForAlias(alias, call, "onAudioPermissionResult");
        } catch (Exception e) {
            e.printStackTrace();
            call.resolve(grantedResult(false));
        }
    }

    @PermissionCallback
    private void onAudioPermissionResult(PluginCall call) {
        call.resolve(grantedResult(hasAudioReadPermission()));
    }

    private boolean hasAudioReadPermission() {
        Context c = getContext();
        String perm = Build.VERSION.SDK_INT >= 33
            ? Manifest.permission.READ_MEDIA_AUDIO
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        return c.checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private JSObject grantedResult(boolean granted) {
        JSObject res = new JSObject();
        res.put("granted", granted);
        return res;
    }

    /* ---------- 扫描 ---------- */

    @PluginMethod
    public void scan(PluginCall call) {
        List<String> dirs = new ArrayList<>();
        JSArray raw = call.getArray("directories");
        if (raw != null) {
            for (int i = 0; i < raw.length(); i++) {
                String d = raw.optString(i, "").trim();
                if (!d.isEmpty() && !dirs.contains(d)) {
                    dirs.add(d.endsWith("/") && d.length() > 1 ? d.substring(0, d.length() - 1) : d);
                }
            }
        }
        boolean skipShort = Boolean.TRUE.equals(call.getBoolean("skipShort"));
        if (dirs.isEmpty()) {
            call.resolve(emptyScanResult());
            return;
        }
        // 扫描耗时不可控（媒体库大时 MediaStore 查询 + 目录遍历会到秒级），
        // 不占 bridge 的动作线程，避免媒体通知等插件调用被卡住
        new Thread(() -> {
            JSObject result;
            try {
                result = doScan(dirs, skipShort);
            } catch (Exception e) {
                e.printStackTrace();
                result = emptyScanResult();
            }
            call.resolve(result);
        }, "local-music-scan").start();
    }

    private JSObject emptyScanResult() {
        JSObject res = new JSObject();
        res.put("items", new JSArray());
        res.put("dirs", new JSArray());
        res.put("failedDirs", new JSArray());
        res.put("skippedShort", 0);
        return res;
    }

    private JSObject doScan(List<String> dirs, boolean skipShort) {
        Context context = getContext();
        ContentResolver resolver = context.getContentResolver();
        List<JSObject> items = new ArrayList<>();
        HashSet<String> seen = new HashSet<>();
        HashSet<Long> albumIds = new HashSet<>();
        int skippedShort = 0;
        boolean mediaStoreAvailable = hasAudioReadPermission();

        /* 第一步：MediaStore（公共目录里已被系统收录的音频） */
        if (mediaStoreAvailable) {
            String[] projection = {
                MediaStore.MediaColumns.DATA,
                MediaStore.Audio.AudioColumns.TITLE,
                MediaStore.Audio.AudioColumns.ARTIST,
                MediaStore.Audio.AudioColumns.ALBUM,
                MediaStore.Audio.AudioColumns.ALBUM_ID,
                MediaStore.Audio.AudioColumns.DURATION,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
            };
            try (Cursor cursor = resolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection, null, null, null)) {
                if (cursor != null) {
                    int colData = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATA);
                    int colTitle = cursor.getColumnIndexOrThrow(MediaStore.Audio.AudioColumns.TITLE);
                    int colArtist = cursor.getColumnIndexOrThrow(MediaStore.Audio.AudioColumns.ARTIST);
                    int colAlbum = cursor.getColumnIndexOrThrow(MediaStore.Audio.AudioColumns.ALBUM);
                    int colAlbumId = cursor.getColumnIndexOrThrow(MediaStore.Audio.AudioColumns.ALBUM_ID);
                    int colDuration = cursor.getColumnIndexOrThrow(MediaStore.Audio.AudioColumns.DURATION);
                    int colSize = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                    int colModified = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED);
                    while (cursor.moveToNext() && items.size() < MAX_SCAN_FILES) {
                        String path = cursor.getString(colData);
                        if (path == null || !hasAudioExt(path) || !seen.add(path)) {
                            continue;
                        }
                        if (!underAnyDir(path, dirs) || !new File(path).canRead()) {
                            continue;
                        }
                        long durationMs = cursor.getLong(colDuration);
                        if (skipShort && durationMs > 0 && durationMs < 60_000L) {
                            skippedShort += 1;
                            continue;
                        }
                        long albumId = cursor.getLong(colAlbumId);
                        if (albumId > 0) {
                            albumIds.add(albumId);
                        }
                        JSObject item = new JSObject();
                        item.put("path", path);
                        item.put("title", fallbackText(cursor.getString(colTitle), nameOf(path), true));
                        item.put("artist", fallbackText(cursor.getString(colArtist), "未知歌手", false));
                        item.put("album", cursor.getString(colAlbum) == null ? "" : cursor.getString(colAlbum));
                        item.put("duration", round1(durationMs / 1000.0));
                        item.put("size", cursor.getLong(colSize));
                        item.put("mtime", cursor.getLong(colModified));
                        item.put("format", extOf(path));
                        if (albumId > 0) {
                            item.put("albumId", albumId);
                        }
                        items.add(item);
                    }
                }
            } catch (Exception e) {
                // MediaStore 查询失败（无权限等）就只走目录遍历
                e.printStackTrace();
            }
        }

        /* 第二步：递归遍历目录补漏（应用私有目录 / 未收录文件） */
        Map<String, Integer> dirCounts = new HashMap<>();
        List<String> failedDirs = new ArrayList<>();
        for (String dir : dirs) {
            File dirFile = new File(dir);
            if (!dirFile.exists() || !dirFile.isDirectory() || !dirFile.canRead()) {
                failedDirs.add(dir);
                dirCounts.put(dir, 0);
                continue;
            }
            int before = items.size();
            walk(dirFile, 0, seen, items, skipShort, context);
            dirCounts.put(dir, items.size() - before);
        }

        /* 第三步：专辑封面（按专辑去重，拷到应用缓存） */
        Map<Long, String> artPaths = new HashMap<>();
        File artDir = new File(context.getCacheDir(), "localmusic_art");
        if (!artDir.exists()) {
            artDir.mkdirs();
        }
        for (Long albumId : albumIds) {
            String artPath = copyAlbumArt(resolver, albumId, artDir);
            if (artPath != null) {
                artPaths.put(albumId, artPath);
            }
        }
        for (JSObject item : items) {
            long albumId = item.optLong("albumId", 0);
            if (albumId > 0 && artPaths.containsKey(albumId)) {
                item.put("artwork", artPaths.get(albumId));
            }
            item.remove("albumId");
        }

        JSObject res = new JSObject();
        JSArray itemsArr = new JSArray();
        for (JSObject item : items) {
            itemsArr.put(item);
        }
        JSArray dirsArr = new JSArray();
        for (String dir : dirs) {
            JSObject d = new JSObject();
            d.put("path", dir);
            d.put("count", dirCounts.getOrDefault(dir, 0));
            dirsArr.put(d);
        }
        JSArray failedArr = new JSArray();
        for (String dir : failedDirs) {
            failedArr.put(dir);
        }
        res.put("items", itemsArr);
        res.put("dirs", dirsArr);
        res.put("failedDirs", failedArr);
        res.put("skippedShort", skippedShort);
        return res;
    }

    private void walk(
        File dir,
        int depth,
        HashSet<String> seen,
        List<JSObject> items,
        boolean skipShort,
        Context context
    ) {
        if (depth > MAX_WALK_DEPTH || items.size() >= MAX_SCAN_FILES) {
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (items.size() >= MAX_SCAN_FILES) {
                return;
            }
            String name = child.getName();
            if (name.startsWith(".")) {
                continue;
            }
            if (child.isDirectory()) {
                walk(child, depth + 1, seen, items, skipShort, context);
            } else if (hasAudioExt(name) && seen.add(child.getAbsolutePath())) {
                JSObject item = buildWalkedItem(child, skipShort, context);
                if (item != null) {
                    items.add(item);
                }
            }
        }
    }

    /** 用 MediaMetadataRetriever 解析遍历到的音频文件；被短音频过滤掉的返回 null */
    private JSObject buildWalkedItem(File file, boolean skipShort, Context context) {
        String path = file.getAbsolutePath();
        String title = nameOf(path).replaceAll("\\.[^.]+$", "");
        String artist = "未知歌手";
        String album = "";
        double durationSec = 0;
        Integer bitrateKbps = null;
        Integer sampleRate = null;
        String artworkPath = null;
        try {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                mmr.setDataSource(path);
                title = fallbackText(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE), title, true);
                artist = fallbackText(
                    firstNonEmpty(
                        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST),
                        mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
                    ),
                    artist, false);
                album = fallbackText(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM), "", false);
                String dur = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                if (dur != null) {
                    try {
                        durationSec = Long.parseLong(dur.trim()) / 1000.0;
                    } catch (NumberFormatException ignored) {
                    }
                }
                String bitrate = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE);
                if (bitrate != null) {
                    try {
                        bitrateKbps = Math.round(Long.parseLong(bitrate.trim()) / 1000.0f);
                    } catch (NumberFormatException ignored) {
                    }
                }
                String samplerate = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE);
                if (samplerate != null) {
                    try {
                        sampleRate = Integer.parseInt(samplerate.trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
                byte[] pic = mmr.getEmbeddedPicture();
                if (pic != null && pic.length > 0 && pic.length <= MAX_EMBEDDED_ART_BYTES) {
                    artworkPath = writeArtCache(context, "f_" + Integer.toHexString(path.hashCode()), pic);
                }
            } finally {
                try {
                    mmr.release();
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            // 解析失败按无元数据处理（文件本身也许还能播）
        }
        if (skipShort && durationSec > 0 && durationSec < 60.0) {
            return null;
        }
        JSObject item = new JSObject();
        item.put("path", path);
        item.put("title", title);
        item.put("artist", artist);
        item.put("album", album);
        item.put("duration", round1(durationSec));
        item.put("size", file.length());
        item.put("mtime", file.lastModified() / 1000);
        item.put("format", extOf(path));
        if (bitrateKbps != null) {
            item.put("bitrate", bitrateKbps);
        }
        if (sampleRate != null) {
            item.put("sampleRate", sampleRate);
        }
        if (artworkPath != null) {
            item.put("artwork", artworkPath);
        }
        return item;
    }

    /** 专辑封面：先试 MediaProvider 的 albumart 内容流，拷贝进应用缓存 */
    private String copyAlbumArt(ContentResolver resolver, long albumId, File artDir) {
        File target = new File(artDir, "a" + albumId + ".img");
        if (target.isFile() && target.length() > 0) {
            return target.getAbsolutePath();
        }
        Uri artUri = ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), albumId);
        try (InputStream in = resolver.openInputStream(artUri)) {
            if (in == null) {
                return null;
            }
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            try (OutputStream out = new FileOutputStream(target)) {
                int n;
                while ((n = in.read(buffer)) > 0) {
                    total += n;
                    if (total > MAX_EMBEDDED_ART_BYTES) {
                        out.close();
                        target.delete();
                        return null;
                    }
                    out.write(buffer, 0, n);
                }
            }
            return total > 0 ? target.getAbsolutePath() : null;
        } catch (Exception e) {
            target.delete();
            return null;
        }
    }

    private String writeArtCache(Context context, String name, byte[] data) {
        File dir = new File(context.getCacheDir(), "localmusic_art");
        if (!dir.exists() && !dir.mkdirs()) {
            return null;
        }
        File target = new File(dir, name + ".img");
        try (OutputStream out = new FileOutputStream(target)) {
            out.write(data);
            return target.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean underAnyDir(String path, List<String> dirs) {
        for (String dir : dirs) {
            if (path.startsWith(dir + "/")) {
                return true;
            }
        }
        return false;
    }

    private static String firstNonEmpty(String a, String b) {
        if (a != null && !a.trim().isEmpty()) {
            return a;
        }
        return b;
    }

    /** 元数据兜底：MediaStore 常给 "<unknown>"；title 保留扩展名去掉后的文件名 */
    private static String fallbackText(String raw, String fallback, boolean fromFilename) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty() || "<unknown>".equalsIgnoreCase(text)) {
            if (fromFilename) {
                String name = fallback.replaceAll("\\.[^.]+$", "");
                return name.isEmpty() ? "未知标题" : name;
            }
            return fallback;
        }
        return text;
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    /* ---------- 删除 ---------- */

    /** MainActivity.onActivityResult 里转发系统删除确认结果的请求码 */
    public static final int DELETE_REQUEST_CODE = 47291;

    /** 系统删除确认框在途的调用（用户确认 / 取消后回传结果） */
    private static PluginCall pendingDeleteCall;

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        File file = new File(path);
        if (!file.exists()) {
            call.resolve(deletedResult(true, null));
            return;
        }
        if (file.delete()) {
            call.resolve(deletedResult(true, null));
            return;
        }
        // 直接删失败：Android 11+ 走系统的删除确认框（他人创建的媒体文件只能这么删）
        if (Build.VERSION.SDK_INT >= 30) {
            Uri mediaUri = findMediaUri(path);
            if (mediaUri != null) {
                try {
                    PendingIntent pi = MediaStore.createDeleteRequest(
                        getContext().getContentResolver(),
                        Collections.singletonList(mediaUri));
                    pendingDeleteCall = call;
                    getActivity().startIntentSenderForResult(
                        pi.getIntentSender(), DELETE_REQUEST_CODE, null, 0, 0, 0);
                    return;
                } catch (Exception e) {
                    e.printStackTrace();
                    pendingDeleteCall = null;
                }
            }
        }
        call.resolve(deletedResult(false, "系统未允许删除该文件"));
    }

    /** MainActivity.onActivityResult 转发系统删除确认框的关闭结果 */
    public static void dispatchDeleteResult(int requestCode, int resultCode) {
        if (requestCode != DELETE_REQUEST_CODE) {
            return;
        }
        PluginCall call = pendingDeleteCall;
        pendingDeleteCall = null;
        if (call == null) {
            return;
        }
        String path = call.getString("path");
        boolean deleted =
            resultCode == Activity.RESULT_OK && path != null && !new File(path).exists();
        call.resolve(deletedResult(deleted, deleted ? null : "未确认删除"));
    }

    private static JSObject deletedResult(boolean deleted, String reason) {
        JSObject res = new JSObject();
        res.put("deleted", deleted);
        if (reason != null) {
            res.put("reason", reason);
        }
        return res;
    }

    private Uri findMediaUri(String path) {
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor c = resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            new String[]{ MediaStore.MediaColumns._ID },
            MediaStore.MediaColumns.DATA + "=?",
            new String[]{ path },
            null)) {
            if (c != null && c.moveToFirst()) {
                return ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, c.getLong(0));
            }
        } catch (Exception ignored) {
        }
        return null;
    }
}
