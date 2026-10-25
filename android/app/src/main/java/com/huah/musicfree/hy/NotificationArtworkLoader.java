package com.huah.musicfree.hy;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.BitmapLoader;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSourceBitmapLoader;
import androidx.media3.session.CacheBitmapLoader;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;

import java.io.File;
import java.util.concurrent.Executors;

/**
 * 系统媒体卡片（下拉通知栏 / 锁屏 / 状态栏）的封面加载器。
 *
 * 为什么不能用 Media3 默认的 {@link DataSourceBitmapLoader}：
 *
 * 1. **取不到本地封面**。本地音乐的封面地址是 WebView 专用的
 *    `https://localhost/_capacitor_file_/...`（Capacitor 只在自己的 WebView 里
 *    拦截这个域名），Media3 走网络栈去请求它必然失败 → 卡片一直没有封面。
 *    这里把 `_capacitor_file_` 还原成真实文件路径、直接读文件解码。
 * 2. **重新匹配后换不了图**。默认的 {@link CacheBitmapLoader} 按 URI 缓存，
 *    而重新匹配是**覆盖同一个封面文件**（`cover_<hash>.img`），URI 不变 →
 *    缓存命中的还是旧图。本地文件按「路径 + 修改时间」判断新鲜度，
 *    文件被新匹配覆盖后自动重新解码。
 *
 * 远端封面（在线歌曲的 http 图）仍交给带缓存的默认实现，省流量也不卡刷新。
 */
@OptIn(markerClass = UnstableApi.class)
final class NotificationArtworkLoader implements BitmapLoader {

    private static final String TAG = "NotificationArtwork";

    private final BitmapLoader remote;
    private final ListeningExecutorService io =
        MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor());

    /** 本地封面单条缓存（卡片只显示当前曲，一条足够）+ 它的「路径:修改时间」指纹 */
    private String localKey = "";
    private Bitmap localBitmap;

    NotificationArtworkLoader(Context context) {
        this.remote = new CacheBitmapLoader(new DataSourceBitmapLoader(context));
    }

    @Override
    public boolean supportsMimeType(String mimeType) {
        return remote.supportsMimeType(mimeType);
    }

    @Override
    public ListenableFuture<Bitmap> decodeBitmap(byte[] data) {
        return remote.decodeBitmap(data);
    }

    @Override
    public ListenableFuture<Bitmap> loadBitmap(Uri uri) {
        final String path = localFilePath(uri);
        if (path == null) {
            return remote.loadBitmap(uri);
        }
        // 本地小图，后台线程解码：通知刷新（播放/暂停/切歌）都在主线程触发，
        // 这里不能让解码阻塞主线程
        return io.submit(
            () -> {
                File file = new File(path);
                if (!file.isFile()) {
                    return null;
                }
                long stamp = file.lastModified();
                String key = path + ":" + stamp;
                synchronized (this) {
                    if (key.equals(localKey) && localBitmap != null && !localBitmap.isRecycled()) {
                        return localBitmap;
                    }
                }
                Bitmap bitmap = BitmapFactory.decodeFile(path);
                Log.i(TAG, "本地封面解码：" + path + "（mtime=" + stamp + "，结果="
                    + (bitmap == null ? "失败" : bitmap.getWidth() + "x" + bitmap.getHeight()) + "）");
                if (bitmap != null) {
                    synchronized (this) {
                        localKey = key;
                        localBitmap = bitmap;
                    }
                }
                return bitmap;
            });
    }

    @Override
    public ListenableFuture<Bitmap> loadBitmapFromMetadata(MediaMetadata metadata) {
        // 默认语义即可：有 artworkData 就先解码它，否则走 loadBitmap(artworkUri)
        return BitmapLoader.super.loadBitmapFromMetadata(metadata);
    }

    /** Capacitor 文件地址 / file:// → 本地绝对路径；不是本地文件返回 null（交给远端实现） */
    private static @Nullable String localFilePath(@Nullable Uri uri) {
        if (uri == null) {
            return null;
        }
        String raw = uri.toString();
        int mark = raw.indexOf("/_capacitor_file_");
        if (mark >= 0) {
            raw = "file://" + raw.substring(mark + "/_capacitor_file_".length());
        }
        if (!raw.startsWith("file://")) {
            return null;
        }
        // getPath() 会丢掉查询串（本地封面地址带 ?v=<匹配时间> 做版本号，
        // 文件系统里当然没有这个查询串）
        String path = Uri.parse(raw).getPath();
        return path == null || path.isEmpty() ? null : path;
    }
}