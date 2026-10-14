package com.huah.musicfree.hy;

import android.content.Context;
import android.util.Log;

import com.whl.quickjs.android.QuickJSLoader;
import com.whl.quickjs.wrapper.JSCallFunction;
import com.whl.quickjs.wrapper.JSFunction;
import com.whl.quickjs.wrapper.JSObject;
import com.whl.quickjs.wrapper.QuickJSContext;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 原生音源插件运行时（QuickJS）
 *
 * 让音源插件的 getMediaSource 在**原生进程内**跑完，彻底不依赖 WebView JS 存活：
 *  - JS 侧（nativePluginRuntime.ts）把已启用插件的源码同步到这里，并落盘；
 *  - MediaPlaybackService 缺源时调用 {@link #resolve}，返回可播放直链后 supplySource 续播；
 *  - WebView 被冻结 / 被杀 / JS 卡死都不影响这条链（这正是后台连播停摆的根因）。
 *
 * 线程模型：QuickJSContext 绑定创建它的线程（checkSameThread），所以每个 Engine
 * 自带一条单线程 executor，所有 evaluate/call 都在那条线程上；外部调用用 Future 等结果。
 * 若一次调用超时（插件死循环之类），整个 Engine 作废：老线程跑完自毁，下次调用新建引擎。
 *
 * 插件同步快照落盘（filesDir/native-plugin-runtime/plugins.json）：
 * 进程被杀后服务重启（WebView 还没起、甚至不打算起）也能自己挂上插件继续解析。
 */
public final class PluginRuntime {

    private static final String TAG = "PluginRuntime";
    private static final String BUNDLE_ASSET = "native-plugin-runtime.js";
    private static final String PERSIST_DIR = "native-plugin-runtime";
    private static final String PERSIST_FILE = "plugins.json";
    /** 单次原生解析的默认上限（要大于 JS 侧单次 getMediaSource 的 15s 超时） */
    public static final long DEFAULT_RESOLVE_TIMEOUT_MS = 20_000L;

    private static volatile PluginRuntime instance;

    public static PluginRuntime getInstance(Context context) {
        PluginRuntime local = instance;
        if (local == null) {
            synchronized (PluginRuntime.class) {
                local = instance;
                if (local == null) {
                    Context app = context.getApplicationContext();
                    local = new PluginRuntime(app);
                    instance = local;
                }
            }
        }
        return local;
    }

    private final Context app;
    private final OkHttpClient http;
    private final File persistFile;

    /** 引擎懒建；所有访问在 synchronized(this) 里做 */
    private Engine engine;
    /** 盘上的插件同步快照（引擎起来时先回灌） */
    private volatile String persistedPluginsJson = "[]";

    private PluginRuntime(Context app) {
        this.app = app;
        this.http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            // 整请求（含重定向链）硬上限：宿主函数同步阻塞在引擎线程上，不能无限等
            .callTimeout(18, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();
        File dir = new File(app.getFilesDir(), PERSIST_DIR);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        this.persistFile = new File(dir, PERSIST_FILE);
        this.persistedPluginsJson = readPersisted();
    }

    /** ---------------- 对外：插件同步 ---------------- */

    /** JS 侧推来的插件快照（[{hash, code, userVariables}, ...]），先落盘再挂载 */
    public void syncPlugins(final String pluginsJson) {
        if (pluginsJson == null || pluginsJson.isEmpty()) {
            return;
        }
        persist(pluginsJson);
        Engine e;
        try {
            e = currentEngine();
        } catch (Exception ex) {
            Log.w(TAG, "同步插件失败（引擎不可用）：" + ex);
            return;
        }
        try {
            e.exec.execute(() -> {
                try {
                    ensureReady(e);
                    if (e.fSync == null) {
                        Log.w(TAG, "同步插件失败：运行时 API 缺失");
                        return;
                    }
                    Object res = e.fSync.call(pluginsJson);
                    Log.i(TAG, "插件同步完成：" + res);
                } catch (Throwable t) {
                    Log.w(TAG, "同步插件异常：" + t);
                } finally {
                    releaseIfPoisoned(e);
                }
            });
        } catch (RejectedExecutionException rex) {
            invalidate(e);
            Log.w(TAG, "同步插件失败：引擎已作废，等待下次重建");
        }
    }

    /** 引擎是否已就绪（诊断用：表示原生侧现在能不能自己解析） */
    public boolean isReady() {
        synchronized (this) {
            return engine != null && engine.ready;
        }
    }

    /** ---------------- 对外：原生解析 ---------------- */

    /**
     * 原生跑一次 getMediaSource（阻塞，可在任意线程调用；内部在引擎线程执行）。
     *
     * @param musicItemJson 完整 musicItem 的 JSON（含 platform/id/qualities 等）
     * @param quality       请求音质（如 standard/flac…，未知档按 standard 处理）
     * @param excludeUrl    刚失败的直链：解析结果与它相同则跳过（换源用）
     * @param timeoutMs     总超时（建议 20s）
     * @return JSON 字符串：{"ok":true,"url":...,"headers":{...},"userAgent":...,"quality":...}
     *         或 {"ok":false,"reason":...}（永远不抛异常）
     */
    public String resolve(String musicItemJson, String quality, String excludeUrl, long timeoutMs) {
        if (musicItemJson == null || musicItemJson.isEmpty()) {
            return failJson("音乐条目为空");
        }
        long budget = timeoutMs > 0 ? timeoutMs : DEFAULT_RESOLVE_TIMEOUT_MS;
        Engine e;
        try {
            e = currentEngine();
        } catch (Exception ex) {
            return failJson("原生运行时不可用：" + ex.getMessage());
        }
        Future<String> future;
        try {
            future = e.exec.submit(
                () -> doResolve(e, musicItemJson, quality, excludeUrl, budget));
        } catch (RejectedExecutionException rex) {
            invalidate(e);
            return failJson("原生运行时已作废");
        }
        try {
            return future.get(budget + 3_000L, TimeUnit.MILLISECONDS);
        } catch (TimeoutException te) {
            // 引擎线程卡在 JS 里（死循环/永不动的 Promise）：整体作废，下次重建
            invalidate(e);
            return failJson("原生解析超时");
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return failJson("原生解析被中断");
        } catch (Exception ex) {
            Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
            return failJson("原生解析异常：" + cause.getMessage());
        }
    }

    /** ---------------- 内部：引擎 ---------------- */

    private static final class Engine {
        final ExecutorService exec;
        volatile QuickJSContext ctx;
        volatile JSFunction fSync;
        volatile JSFunction fStart;
        volatile JSFunction fJobState;
        volatile JSFunction fJobResult;
        volatile JSFunction fJobError;
        volatile JSFunction fTick;
        volatile boolean ready;
        volatile boolean poisoned;

        Engine(String name) {
            exec = Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, name);
                t.setPriority(Thread.NORM_PRIORITY - 1);
                return t;
            });
        }
    }

    private synchronized Engine currentEngine() {
        if (engine == null) {
            engine = new Engine("plugin-runtime-" + System.nanoTime());
        }
        return engine;
    }

    /** 作废一个引擎（卡死/被判定不可用）：老线程跑完当前任务后自毁，之后新建引擎 */
    private void invalidate(Engine e) {
        if (e == null) {
            return;
        }
        e.poisoned = true;
        synchronized (this) {
            if (engine == e) {
                engine = null;
            }
        }
        e.exec.shutdownNow();
    }

    private void releaseIfPoisoned(Engine e) {
        if (e == null || !e.poisoned) {
            return;
        }
        QuickJSContext ctx = e.ctx;
        e.ctx = null;
        e.ready = false;
        if (ctx != null) {
            try {
                ctx.destroy();
                Log.i(TAG, "作废的引擎已释放");
            } catch (Throwable ignored) {
            }
        }
        e.exec.shutdown();
    }

    /**
     * 首次使用时建引擎：加载 bundle、注入宿主 HTTP、回灌落盘的插件。
     * 必须在该 Engine 的 executor 线程上调用。
     */
    private void ensureReady(Engine e) throws Exception {
        if (e.ready && e.ctx != null) {
            return;
        }
        if (e.ctx != null) {
            throw new IllegalStateException("引擎初始化未完成");
        }
        QuickJSLoader.init();
        QuickJSContext ctx = QuickJSContext.create();
        boolean ok = false;
        try {
            ctx.setConsole(new LogcatConsole());
            JSObject global = ctx.getGlobalObject();
            // 同步 HTTP 宿主函数：插件的 axios 请求直接落到这里（OkHttp，无跨域限制）
            global.setProperty("__nativeHttp", (JSCallFunction) args -> nativeHttpCall(args));
            String bundle = readAsset(BUNDLE_ASSET);
            ctx.evaluate(bundle, "native-plugin-runtime.js");
            e.fSync = global.getJSFunction("__sync");
            e.fStart = global.getJSFunction("__start");
            e.fJobState = global.getJSFunction("__jobState");
            e.fJobResult = global.getJSFunction("__jobResult");
            e.fJobError = global.getJSFunction("__jobError");
            e.fTick = global.getJSFunction("__tick");
            if (e.fSync == null || e.fStart == null || e.fJobState == null
                || e.fJobResult == null || e.fJobError == null || e.fTick == null) {
                throw new IllegalStateException("运行时 API 缺失（bundle 版本不匹配？）");
            }
            String persisted = persistedPluginsJson;
            if (persisted != null && persisted.length() > 2) {
                Object res = e.fSync.call(persisted);
                Log.i(TAG, "启动回灌插件：" + res);
            }
            e.ctx = ctx;
            e.ready = true;
            ok = true;
            Log.i(TAG, "引擎就绪（QuickJS）");
        } finally {
            if (!ok) {
                try {
                    ctx.destroy();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private String doResolve(Engine e, String musicItemJson, String quality,
                             String excludeUrl, long timeoutMs) {
        try {
            ensureReady(e);
            if (e.fStart == null) {
                return failJson("原生运行时未就绪");
            }
            e.fStart.call(
                "resolve",
                musicItemJson,
                quality == null ? "standard" : quality,
                excludeUrl == null ? "" : excludeUrl);
            long deadline = System.currentTimeMillis() + timeoutMs;
            String state = asString(e.fJobState.call());
            while ("pending".equals(state)) {
                if (System.currentTimeMillis() > deadline) {
                    return failJson("原生解析超时");
                }
                // 驱动到期定时器（QuickJS 无事件循环，靠它喂 axios 超时/插件 sleep）
                e.fTick.call();
                Thread.sleep(15L);
                state = asString(e.fJobState.call());
            }
            if ("fulfilled".equals(state)) {
                return asString(e.fJobResult.call());
            }
            return failJson("原生解析失败：" + asString(e.fJobError.call()));
        } catch (Throwable t) {
            return failJson("原生解析异常：" + t.getMessage());
        } finally {
            releaseIfPoisoned(e);
        }
    }

    /** ---------------- 内部：宿主 HTTP ---------------- */

    private String nativeHttpCall(Object[] args) {
        // 宿主函数绝不能抛：JNI 层抛 Java 异常会把引擎打成不可预期状态，一律转 JSON
        try {
            String url = argString(args, 0);
            String method = argString(args, 1);
            if (method.isEmpty()) {
                method = "GET";
            }
            method = method.toUpperCase();
            String headersJson = argString(args, 2);
            String body = args.length > 3 && args[3] != null ? String.valueOf(args[3]) : null;

            if (url.isEmpty()) {
                return new JSONObject().put("error", "url 为空").toString();
            }

            Request.Builder rb = new Request.Builder().url(url);
            if (!headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                for (String key : jsonKeys(headers)) {
                    String value = headers.has(key) && !headers.isNull(key)
                        ? headers.getString(key) : null;
                    if (value == null || value.isEmpty() || "null".equals(value)) {
                        continue;
                    }
                    try {
                        rb.header(key, value);
                    } catch (IllegalArgumentException ih) {
                        // 插件塞了非法头（换行/非 ASCII）：丢掉该头，别让整个请求失败
                        Log.d(TAG, "忽略非法请求头 " + key + ": " + ih.getMessage());
                    }
                }
            }
            boolean hasBody = !"GET".equals(method) && !"HEAD".equals(method);
            if (hasBody) {
                MediaType type = MediaType.parse(
                    headersContentType(headersJson, "application/json; charset=utf-8"));
                rb.method(method, RequestBody.create(body == null ? "" : body, type));
            } else {
                rb.method(method, null);
            }

            try (Response resp = http.newCall(rb.build()).execute()) {
                JSONObject out = new JSONObject();
                out.put("status", resp.code());
                JSONObject respHeaders = new JSONObject();
                for (String name : resp.headers().names()) {
                    respHeaders.put(name.toLowerCase(), resp.headers().get(name));
                }
                out.put("headers", respHeaders);
                String text = "";
                if (resp.body() != null) {
                    text = resp.body().string();
                }
                out.put("text", text);
                return out.toString();
            }
        } catch (Throwable t) {
            try {
                String msg = t.getMessage() != null ? t.getMessage() : t.toString();
                return new JSONObject().put("error", msg).toString();
            } catch (Exception ignore) {
                return "{\"error\":\"native http failed\"}";
            }
        }
    }

    // ---------------- 小工具 ----------------

    private static String argString(Object[] args, int idx) {
        if (args == null || args.length <= idx || args[idx] == null) {
            return "";
        }
        return String.valueOf(args[idx]);
    }

    /** org.json 的 names() 返回 JSONArray（不是 Iterable），统一走这个取键 */
    private static java.util.List<String> jsonKeys(JSONObject obj) {
        java.util.List<String> keys = new java.util.ArrayList<>();
        JSONArray names = obj.names();
        if (names != null) {
            for (int i = 0; i < names.length(); i++) {
                String k = names.optString(i, null);
                if (k != null) {
                    keys.add(k);
                }
            }
        }
        return keys;
    }

    private static String headersContentType(String headersJson, String fallback) {
        try {
            JSONObject headers = new JSONObject(headersJson);
            for (String key : jsonKeys(headers)) {
                if ("content-type".equalsIgnoreCase(key)) {
                    return headers.optString(key, fallback);
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private static String asString(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static String failJson(String reason) {
        try {
            return new JSONObject().put("ok", false).put("reason", reason).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"reason\":\"" + reason.replace("\"", "'") + "\"}";
        }
    }

    private void persist(String json) {
        persistedPluginsJson = json;
        FileOutputStream fos = null;
        File tmp = new File(persistFile.getParentFile(), PERSIST_FILE + ".tmp");
        try {
            fos = new FileOutputStream(tmp);
            fos.write(json.getBytes(StandardCharsets.UTF_8));
            fos.getFD().sync();
            fos.close();
            fos = null;
            if (!tmp.renameTo(persistFile)) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        } catch (Throwable t) {
            Log.w(TAG, "插件快照落盘失败：" + t);
            if (fos != null) {
                try {
                    fos.close();
                } catch (Throwable ignored) {
                }
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private String readPersisted() {
        FileInputStream fis = null;
        try {
            if (!persistFile.exists()) {
                return "[]";
            }
            fis = new FileInputStream(persistFile);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            String json = bos.toString("UTF-8");
            return json.isEmpty() ? "[]" : json;
        } catch (Throwable t) {
            Log.w(TAG, "读取插件快照失败：" + t);
            return "[]";
        } finally {
            if (fis != null) {
                try {
                    fis.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private String readAsset(String name) throws Exception {
        InputStream in = app.getAssets().open(name);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return bos.toString("UTF-8");
        } finally {
            in.close();
        }
    }

    /** console → logcat（QuickJS 侧的 console.stdout 由这里接管） */
    private static final class LogcatConsole implements QuickJSContext.Console {
        @Override
        public void log(String info) {
            Log.d(TAG, info);
        }

        @Override
        public void info(String info) {
            Log.i(TAG, info);
        }

        @Override
        public void warn(String info) {
            Log.w(TAG, info);
        }

        @Override
        public void error(String info) {
            Log.e(TAG, info);
        }
    }
}
