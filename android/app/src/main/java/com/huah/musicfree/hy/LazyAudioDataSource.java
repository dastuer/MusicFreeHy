package com.huah.musicfree.hy;

import android.net.Uri;

import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * 惰性解析数据源：把「解析音源」从推送队列时推迟到临播前。
 *
 * 队列条目进 ExoPlayer 时只带占位 URI `mfhy://<mediaId>`。ExoPlayer 预缓冲到
 * 这条（通常比实际出声早 30~60s）才会 open，这时才向 {@link Resolver} 要真实直链。
 *
 * 为什么要这样：
 *  - 解析时机贴近播放，**直链过期面几乎消失**（旧实现是 pushQueuePlan 时就解析，
 *    队列深处的直链可能躺几小时）；
 *  - 整条队列都能进播放器列表，不再需要「3 首可播窗 + needsource 拉取协议 +
 *    shadow 计划队列」那一整套状态机；
 *  - 解析在 ExoPlayer 的加载线程上阻塞等待，主线程与 WebView JS 完全不参与
 *    ——JS 被冻结/杀掉也照常续播。
 *
 * 非 `mfhy://` 的 URI（JS 已解析好的直链、本地文件、外部控制器推来的地址）
 * 原样交给内层数据源，行为与改动前一致。
 */
public final class LazyAudioDataSource implements DataSource {

    /** 占位 URI 的 scheme */
    public static final String SCHEME = "mfhy";

    /** 解析结果：真实可播地址 + 需要随请求带上的头（UA/Referer/Cookie 等） */
    public static final class Resolved {
        public final String url;
        public final Map<String, String> headers;

        public Resolved(String url, Map<String, String> headers) {
            this.url = url;
            this.headers = headers == null ? new HashMap<>() : headers;
        }
    }

    public interface Resolver {
        /**
         * 解析一条队列条目的可播地址。
         * 失败请抛 IOException —— ExoPlayer 会把它当作该条目的播放错误，
         * 触发上层的跳歌自愈（不要返回 null 静默失败）。
         */
        Resolved resolve(String mediaId) throws IOException;
    }

    private final DataSource inner;
    private final Resolver resolver;
    /** 最近一次实际打开的 spec（getUri 要用真实地址，不能回占位 URI） */
    private DataSpec currentSpec;

    public LazyAudioDataSource(DataSource inner, Resolver resolver) {
        this.inner = inner;
        this.resolver = resolver;
    }

    /**
     * 从占位 URI 取 mediaId。
     *
     * 坑：`Uri.parse("mfhy://LOCTEST-1")` 会把 `LOCTEST-1` 当成 **host**，
     * 于是 `getSchemeSpecificPart()` 得到的是 `//LOCTEST-1`（带两个斜杠），
     * 拿去查队列必然查不到。这里统一按「去掉 scheme 与前导斜杠」处理，
     * 并兼容 mediaId 里可能出现的转义字符。
     */
    static String mediaIdOf(Uri uri) {
        if (uri == null) {
            return "";
        }
        // authority 优先（普通情况下 mediaId 就在 host 位）
        String authority = uri.getAuthority();
        if (authority != null && !authority.isEmpty()) {
            return Uri.decode(authority);
        }
        String ssp = uri.getSchemeSpecificPart();
        if (ssp == null) {
            return "";
        }
        while (ssp.startsWith("/")) {
            ssp = ssp.substring(1);
        }
        return Uri.decode(ssp);
    }

    @Override
    public void addTransferListener(TransferListener transferListener) {
        inner.addTransferListener(transferListener);
    }

    @Override
    public long open(DataSpec dataSpec) throws IOException {
        DataSpec effective = dataSpec;
        Uri uri = dataSpec.uri;
        if (uri != null && SCHEME.equals(uri.getScheme())) {
            String mediaId = mediaIdOf(uri);
            Resolved resolved;
            try {
                resolved = resolver.resolve(mediaId);
            } catch (IOException e) {
                throw e;
            } catch (Throwable t) {
                throw new IOException("解析音源失败：" + t.getMessage(), t);
            }
            if (resolved == null || resolved.url == null || resolved.url.isEmpty()) {
                throw new IOException("解析音源失败：没有拿到可播放地址");
            }
            effective = dataSpec.buildUpon()
                .setUri(Uri.parse(normalize(resolved.url)))
                .setHttpRequestHeaders(
                    resolved.headers == null ? new HashMap<>() : resolved.headers)
                .build();
        }
        currentSpec = effective;
        return inner.open(effective);
    }

    /**
     * src 归一化：capacitor 的文件地址还原为 file:// 绝对路径
     * （ExoPlayer 的文件数据源需要 scheme，与旧 resolveSrc 同规则）
     */
    private static String normalize(String url) {
        int fileMark = url.indexOf("/_capacitor_file_");
        if (fileMark >= 0) {
            return "file://" + url.substring(fileMark + "/_capacitor_file_".length());
        }
        return url;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        return inner.read(buffer, offset, length);
    }

    @Override
    public Uri getUri() {
        return currentSpec == null ? null : currentSpec.uri;
    }

    @Override
    public Map<String, java.util.List<String>> getResponseHeaders() {
        return inner.getResponseHeaders();
    }

    @Override
    public void close() throws IOException {
        currentSpec = null;
        inner.close();
    }
}
