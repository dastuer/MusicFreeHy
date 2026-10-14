/**
 * 原生音源插件运行时（跑在 Android 端 QuickJS 里，不依赖 WebView JS 存活）
 *
 * 与 pluginWorker.ts（WebView Worker 版）是同一套挂载语义：CommonJS 风格插件代码 +
 * Function 构造器沙箱 + 白名单 require，纯逻辑共用 pluginSandboxCore.ts。差异只有两点：
 *  1. 网络走 Java 注入的同步宿主函数 `__nativeHttp`（OkHttp，无跨域、可带 UA/Referer），
 *     所以插件的 getMediaSource 能在一次 evaluate 里跑完（QuickJS 会把微任务排干）；
 *  2. 消息循环换成 Java 侧的 `__start / __jobState / __tick` 任务协议：
 *     Java 启动任务 → 轮询状态（必要时 __tick 触发到期定时器）→ 取回 JSON 结果。
 *
 * Java 侧约定（PluginRuntime.java）：本 bundle 被 evaluate 后，全局必须已存在
 * `__nativeHttp(url, method, headersJson, body) -> string|null`（返回 JSON：
 * {"status":200,"headers":{...},"text":"..."}）。
 */

import "./quickjsPreload"; // 必须第一个：axios/cheerio 等在模块初始化阶段就要 atob/Buffer
import axios from "axios";
import {
    buildUrl,
    makeAxiosError,
    mountPlugin,
    normalizeHeaders,
    parseTextData,
    patchResultPlatform,
    sanitize,
    type MountedPlugin,
} from "../core/pluginSandboxCore";

/** 与 trackPlayer.QUALITY_LADDER 对齐（音质由高到低，原生侧不 import trackPlayer：那是 UI 层） */
const QUALITY_LADDER = ["low", "standard", "high", "super"] as const;

/** 单次 getMediaSource 最长等待（与 trackPlayer.MEDIA_SOURCE_TIMEOUT 对齐） */
const MEDIA_SOURCE_TIMEOUT = 15000;

type QualityKey = (typeof QUALITY_LADDER)[number];

interface RuntimeResolveOk {
    ok: true;
    url: string;
    headers: Record<string, string>;
    userAgent: string;
    quality: QualityKey | null;
}

interface RuntimeResolveFail {
    ok: false;
    reason: string;
}

type RuntimeResolveResult = RuntimeResolveOk | RuntimeResolveFail;

/** ---------------- 环境补丁（QuickJS 没有浏览器全局，缺一个插件就可能 ReferenceError） ---------------- */

function polyfillGlobals() {
    const g = globalThis as any;

    // 定时器：QuickJS 无事件循环，Java 侧靠 __tick 驱动到期任务
    if (typeof g.setTimeout !== "function") {
        let seq = 0;
        const timers = new Map<number, { fn: any; args: any[]; due: number; interval?: number }>();
        const set = (fn: any, ms: any, args: any[], interval?: number) => {
            const id = ++seq;
            timers.set(id, {
                fn,
                args,
                due: Date.now() + Math.max(0, Number(ms) || 0),
                interval,
            });
            return id;
        };
        g.setTimeout = (fn: any, ms?: any, ...args: any[]) => set(fn, ms, args);
        g.clearTimeout = (id: any) => {
            timers.delete(id);
        };
        g.setInterval = (fn: any, ms?: any, ...args: any[]) =>
            set(fn, ms, args, Math.max(1, Number(ms) || 1));
        g.clearInterval = (id: any) => {
            timers.delete(id);
        };
        g.__tick = () => {
            const now = Date.now();
            let ran = 0;
            for (const [id, t] of [...timers]) {
                if (t.due > now) {
                    continue;
                }
                if (t.interval) {
                    t.due = now + t.interval;
                } else {
                    timers.delete(id);
                }
                try {
                    t.fn(...t.args);
                } catch (e: any) {
                    console.error("[native-runtime] 定时器回调异常", e?.message ?? e);
                }
                if (++ran >= 32) {
                    break; // 自循环定时器不饿死本次任务轮询
                }
            }
        };
    }

    // URL / URLSearchParams：mountPlugin 把 URL 当作用参数传进插件，插件普遍用它拼地址
    if (typeof g.URL !== "function") {
        class SimpleURL {
            href = "";
            protocol = "";
            host = "";
            hostname = "";
            port = "";
            pathname = "";
            search = "";
            hash = "";
            origin = "";
            constructor(input?: string, base?: string) {
                const raw = String(input ?? "");
                const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)
                    ? raw
                    : `${String(base ?? "https://placeholder.local").replace(/\/+$/, "")}/${raw}`;
                const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(abs);
                if (m) {
                    this.protocol = (m[1] ?? "").toLowerCase();
                    this.host = m[2] ?? "";
                    const parts = this.host.split(":");
                    this.hostname = parts[0] ?? "";
                    this.port = parts[1] ?? "";
                    this.pathname = m[3] || "/";
                    this.search = m[4] ?? "";
                    this.hash = m[5] ?? "";
                    this.href = abs;
                    this.origin = `${this.protocol}//${this.host}`;
                } else {
                    this.pathname = abs;
                    this.href = abs;
                }
            }
            toString() {
                return this.href;
            }
        }
        (SimpleURL as any).createObjectURL = () => "";
        (SimpleURL as any).revokeObjectURL = () => undefined;
        g.URL = SimpleURL;
    }
    if (typeof g.URLSearchParams !== "function") {
        g.URLSearchParams = class URLSearchParamsStub {
            private pairs: [string, string][] = [];
            constructor(init?: any) {
                if (typeof init === "string") {
                    init
                        .replace(/^\?/, "")
                        .split("&")
                        .forEach((kv: string) => {
                            if (!kv) return;
                            const i = kv.indexOf("=");
                            this.pairs.push([
                                decodeURIComponent(i < 0 ? kv : kv.slice(0, i)),
                                decodeURIComponent(i < 0 ? "" : kv.slice(i + 1)),
                            ]);
                        });
                } else if (init && typeof init === "object") {
                    Object.entries(init).forEach(([k, v]) => this.pairs.push([k, String(v)]));
                }
            }
            append(k: string, v: string) {
                this.pairs.push([String(k), String(v)]);
            }
            get(k: string) {
                const hit = this.pairs.find((p) => p[0] === k);
                return hit ? hit[1] : null;
            }
            getAll(k: string) {
                return this.pairs.filter((p) => p[0] === k).map((p) => p[1]);
            }
            has(k: string) {
                return this.pairs.some((p) => p[0] === k);
            }
            set(k: string, v: string) {
                this.pairs = this.pairs.filter((p) => p[0] !== k);
                this.pairs.push([String(k), String(v)]);
            }
            delete(k: string) {
                this.pairs = this.pairs.filter((p) => p[0] !== k);
            }
            forEach(cb: (v: string, k: string) => void) {
                this.pairs.forEach((p) => cb(p[1], p[0]));
            }
            toString() {
                return this.pairs
                    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                    .join("&");
            }
        };
    }
    if (typeof g.FormData !== "function") {
        g.FormData = class FormDataStub {
            private entries: [string, any][] = [];
            append(k: string, v: any) {
                this.entries.push([String(k), v]);
            }
            get(k: string) {
                return this.entries.find((e) => e[0] === k)?.[1] ?? null;
            }
            has(k: string) {
                return this.entries.some((e) => e[0] === k);
            }
            forEach(cb: (v: any, k: string) => void) {
                this.entries.forEach((e) => cb(e[1], e[0]));
            }
        };
    }
    if (typeof g.AbortController !== "function") {
        g.AbortController = class AbortControllerStub {
            signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
            abort() {
                (this.signal as any).aborted = true;
            }
        };
    }
    if (typeof g.TextEncoder !== "function") {
        g.TextEncoder = class TextEncoderStub {
            encode(input?: string) {
                const s = String(input ?? "");
                const out = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) {
                    out[i] = s.charCodeAt(i) & 0xff;
                }
                return out;
            }
        };
    }
    if (typeof g.atob !== "function") {
        const chars =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        g.atob = (b64: string) => {
            const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
            let out = "";
            for (let i = 0; i < clean.length; i += 4) {
                const c0 = chars.indexOf(clean[i]);
                const c1 = chars.indexOf(clean[i + 1] ?? "A");
                const c2 = chars.indexOf(clean[i + 2] ?? "A");
                const c3 = chars.indexOf(clean[i + 3] ?? "A");
                out += String.fromCharCode((c0 << 2) | (c1 >> 4));
                if (clean[i + 2] !== undefined) out += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
                if (clean[i + 3] !== undefined) out += String.fromCharCode(((c2 & 3) << 6) | c3);
            }
            return out;
        };
    }
    if (typeof g.fetch !== "function") {
        // 插件理论上只用 axios；给个会报错的 fetch，避免 ReferenceError 难排查
        g.fetch = () => Promise.reject(new Error("原生运行时请使用 axios（fetch 不可用）"));
    }
    if (typeof g.performance !== "object" || !g.performance?.now) {
        g.performance = { now: () => Date.now() };
    }
}

polyfillGlobals();

/** ---------------- 网络层：同步原生 HTTP 适配器 ---------------- */

declare global {
    // Java 侧注入（QuickJSContext.set("nativeHttp", JSCallFunction) → globalThis.__nativeHttp）
    function __nativeHttp(
        url: string,
        method: string,
        headersJson: string,
        body: string | null,
    ): string | null;
}

function nativeHttpAdapter(config: any): Promise<any> {
    const http = (globalThis as any).__nativeHttp;
    if (typeof http !== "function") {
        return Promise.reject(makeAxiosError("原生 HTTP 宿主未注入", config));
    }
    const method = String(config.method ?? "get").toUpperCase();
    const fullUrl = buildUrl(
        (config.baseURL ?? "") + config.url,
        config.params,
        config.paramsSerializer,
    );
    const headers = normalizeHeaders(config.headers);

    let body: any = config.data;
    if (body !== undefined && body !== null && typeof body !== "string") {
        if (body instanceof URLSearchParams) {
            body = body.toString();
        } else if (body instanceof ArrayBuffer || ArrayBuffer.isView?.(body)) {
            // 原生宿主只吃字符串：二进制按 JSON 串发（插件解析链基本不用二进制请求体）
            body = String(body);
        } else {
            body = JSON.stringify(body);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
                headers["Content-Type"] = "application/json";
            }
        }
    }

    let raw: string | null = null;
    try {
        raw = http(fullUrl, method, JSON.stringify(headers), body ?? null);
    } catch (e: any) {
        return Promise.reject(
            makeAxiosError(`原生网络错误：${e?.message ?? e}`, config),
        );
    }
    if (raw === null || raw === undefined) {
        return Promise.reject(makeAxiosError("原生网络请求失败（无响应）", config));
    }
    let res: any;
    try {
        res = JSON.parse(raw);
    } catch {
        return Promise.reject(makeAxiosError("原生网络响应解析失败", config));
    }
    if (res && typeof res.error === "string" && res.error) {
        // 宿主函数不抛异常：错误一律以 {"error":"..."} 回来
        return Promise.reject(makeAxiosError(`原生网络错误：${res.error}`, config));
    }

    const response = {
        data: parseTextData(res.text ?? "", config.responseType),
        status: res.status ?? 0,
        statusText: "",
        headers: res.headers ?? {},
        config,
    };
    const validate = config.validateStatus;
    if (!validate || validate(response.status)) {
        return Promise.resolve(response);
    }
    return Promise.reject(
        makeAxiosError(
            `Request failed with status code ${response.status}`,
            config,
            response,
        ),
    );
}

axios.defaults.adapter = nativeHttpAdapter as any;
axios.defaults.timeout = MEDIA_SOURCE_TIMEOUT;

/** 与 pluginWorker 一致：单条 set-cookie 暴露成 x-set-cookie */
axios.interceptors.response.use((response) => {
    const setCookie = (response.headers as any)?.["set-cookie"];
    if (Array.isArray(setCookie) && setCookie.length === 1) {
        (response.headers as any)["x-set-cookie"] = setCookie;
    }
    return response;
});

/** ---------------- 挂载表 ---------------- */

const mounted = new Map<string, MountedPlugin>();
/** 同步下来的插件顺序（与 JS getPlugins() 一致，决定同平台多插件时选谁） */
let pluginOrder: string[] = [];

function orderedEntries(): MountedPlugin[] {
    const out: MountedPlugin[] = [];
    for (const hash of pluginOrder) {
        const entry = mounted.get(hash);
        if (entry) {
            out.push(entry);
        }
    }
    // 兜底：不在顺序表里的（同步竞态残留）排在后面
    for (const [hash, entry] of mounted) {
        if (!pluginOrder.includes(hash)) {
            out.push(entry);
        }
    }
    return out;
}

/** ---------------- 音质阶梯（对齐 trackPlayer） ---------------- */

function pickSupportedQuality(
    requested: QualityKey,
    qualities?: Record<string, any>,
): QualityKey | null {
    if (!qualities || typeof qualities !== "object") {
        return null;
    }
    const supported = QUALITY_LADDER.filter((q) => qualities[q]);
    if (!supported.length) {
        return null;
    }
    const reqIdx = QUALITY_LADDER.indexOf(requested);
    const atOrBelow = supported.filter((q) => QUALITY_LADDER.indexOf(q) <= reqIdx);
    return (atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : supported[0]) as QualityKey;
}

function resolveQualityLadder(first: QualityKey): QualityKey[] {
    const idx = QUALITY_LADDER.indexOf(first);
    const ladder = QUALITY_LADDER.slice(0, idx + 1).reverse() as QualityKey[];
    if (!ladder.includes("standard")) {
        ladder.push("standard");
    }
    return ladder.slice(0, 3);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`${label} 超时`));
            }
        }, ms);
        Promise.resolve(p).then(
            (v) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            (e) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(e);
                }
            },
        );
    });
}

/** ---------------- 对 Java 暴露的解析入口 ---------------- */

async function resolveMediaSource(
    musicItem: any,
    requestedQuality: string,
    excludeUrl: string,
): Promise<RuntimeResolveResult> {
    // 本地文件（本地音乐 / 已下载的歌）：不经插件，直接给原生可播的文件地址
    const localPath =
        typeof musicItem?.localPath === "string" && musicItem.localPath
            ? String(musicItem.localPath)
            : "";
    if (localPath) {
        const fileUrl = `file://${localPath}`;
        if (!excludeUrl || fileUrl !== excludeUrl) {
            return { ok: true, url: fileUrl, headers: {}, userAgent: "", quality: null };
        }
    }
    const platform = String(musicItem?.platform ?? "");
    if (!platform) {
        return { ok: false, reason: "音乐条目缺少 platform" };
    }
    const candidates = orderedEntries().filter(
        (e) => e?.instance?.platform === platform && !e.instance?.__nativeDisabled,
    );
    if (!candidates.length) {
        return {
            ok: false,
            reason: `未找到平台「${platform}」的音源插件（原生侧未同步到已启用的插件）`,
        };
    }
    const entry = candidates[0];
    const instance = entry.instance;
    if (typeof instance?.getMediaSource !== "function") {
        return { ok: false, reason: `音源「${platform}」不支持 getMediaSource` };
    }

    const requested = (QUALITY_LADDER.includes(requestedQuality as QualityKey)
        ? requestedQuality
        : "standard") as QualityKey;
    const start = pickSupportedQuality(requested, musicItem?.qualities) ?? requested;
    let lastError = "";
    for (const quality of resolveQualityLadder(start)) {
        try {
            const source = await withTimeout(
                Promise.resolve(instance.getMediaSource(musicItem, quality)),
                MEDIA_SOURCE_TIMEOUT,
                `getMediaSource(${quality})`,
            );
            const url = source && typeof source === "object" ? source.url : "";
            if (url) {
                if (excludeUrl && url === excludeUrl) {
                    lastError = `${quality} 返回的直链与刚失败的相同`;
                    continue;
                }
                return {
                    ok: true,
                    url: String(url),
                    headers: (source.headers ?? {}) as Record<string, string>,
                    userAgent: source.userAgent ? String(source.userAgent) : "",
                    quality: quality as QualityKey,
                };
            }
            lastError = `${quality} 未返回链接`;
        } catch (e: any) {
            lastError = `${quality}: ${e?.message ?? e}`;
        }
    }
    if (musicItem?.url && musicItem.url !== excludeUrl) {
        return {
            ok: true,
            url: String(musicItem.url),
            headers: {},
            userAgent: "",
            quality: null,
        };
    }
    return {
        ok: false,
        reason: lastError
            ? `音源「${platform}」解析失败（${lastError}）`
            : `音源「${platform}」没有返回可播放的链接`,
    };
}

async function callMethod(
    hash: string,
    method: string,
    argsJson: string,
): Promise<any> {
    const st = mounted.get(hash);
    if (!st || !st.instance) {
        throw new Error("插件不存在或未挂载");
    }
    const fn = st.instance[method];
    if (typeof fn !== "function") {
        throw new Error(`插件不支持 ${method}`);
    }
    let args: any[] = [];
    try {
        args = argsJson ? JSON.parse(argsJson) : [];
    } catch {
        args = [];
    }
    const result = await withTimeout(
        Promise.resolve(fn.apply(st.instance, args)),
        MEDIA_SOURCE_TIMEOUT * 2,
        method,
    );
    const out = sanitize(result);
    patchResultPlatform(out, st.instance.platform);
    return out;
}

/** ---------------- Java 侧任务协议 ---------------- */

interface RuntimeJob {
    id: number;
    kind: string;
}

let jobSeq = 0;
let job: RuntimeJob = { id: 0, kind: "" };
let jobStateValue = "idle"; // idle | pending | fulfilled | rejected
let jobResultJson = "";
let jobError = "";

function installTaskApi() {
    const g = globalThis as any;

    /** 挂载/同步插件（同步返回 JSON 字符串） */
    g.__sync = (pluginsJson: string): string => {
        let list: any[] = [];
        try {
            list = JSON.parse(pluginsJson || "[]");
        } catch (e: any) {
            return JSON.stringify({ ok: false, reason: `插件同步数据解析失败：${e?.message ?? e}` });
        }
        const wanted = new Set<string>();
        const mountedNow: string[] = [];
        const failed: { hash: string; reason: string }[] = [];
        let orderChanged = false;
        const nextOrder: string[] = [];
        for (const item of list) {
            const hash = String(item?.hash ?? "");
            const code = typeof item?.code === "string" ? item.code : "";
            if (!hash || !code) {
                continue;
            }
            wanted.add(hash);
            nextOrder.push(hash);
            const existing = mounted.get(hash);
            if (existing) {
                // 用户变量可能变：原地更新
                const vars = item?.userVariables ?? {};
                if (JSON.stringify(existing.userVariablesRef.current) !== JSON.stringify(vars)) {
                    existing.userVariablesRef.current = vars;
                }
                continue;
            }
            const info = mountPlugin(
                code,
                item?.userVariables ?? {},
                (h, entry) => mounted.set(h, entry),
            );
            if (info.state === "Mounted" && info.hash === hash) {
                mountedNow.push(hash);
            } else {
                mounted.delete(hash);
                failed.push({ hash, reason: info.errorReason ?? "CannotParse" });
            }
        }
        const removed: string[] = [];
        for (const hash of [...mounted.keys()]) {
            if (!wanted.has(hash)) {
                mounted.delete(hash);
                removed.push(hash);
            }
        }
        if (nextOrder.join(",") !== pluginOrder.join(",")) {
            pluginOrder = nextOrder;
            orderChanged = true;
        }
        return JSON.stringify({
            ok: true,
            mounted: mountedNow,
            removed,
            failed,
            total: mounted.size,
            orderChanged,
        });
    };

    g.__unmount = (hash: string): string => {
        mounted.delete(hash);
        pluginOrder = pluginOrder.filter((h) => h !== hash);
        return "ok";
    };

    g.__health = (): string =>
        JSON.stringify({
            plugins: [...mounted.values()].map((e) => ({
                platform: e.instance?.platform ?? "",
                version: e.instance?.version ?? "",
            })),
            order: pluginOrder,
            pending: jobStateValue === "pending",
        });

    /**
     * 启动一个异步任务（call / resolve），返回任务 id。
     * 结果先落到 __jobResult/__jobError，Java 轮询 __jobState 后取走。
     */
    g.__start = (kind: string, a: string, b: string, c: string): number => {
        const id = ++jobSeq;
        job = { id, kind };
        jobStateValue = "pending";
        jobResultJson = "";
        jobError = "";
        const guard = (fn: () => Promise<any>) => {
            Promise.resolve()
                .then(fn)
                .then(
                    (value) => {
                        if (job.id !== id) {
                            return; // 已被后续任务覆盖（超时放弃的旧任务）
                        }
                        jobStateValue = "fulfilled";
                        try {
                            jobResultJson = JSON.stringify(value ?? null);
                        } catch {
                            jobResultJson = "null";
                        }
                    },
                    (e: any) => {
                        if (job.id !== id) {
                            return;
                        }
                        jobStateValue = "rejected";
                        jobError = String(e?.message ?? e ?? "插件调用失败");
                    },
                );
        };
        try {
            if (kind === "call") {
                guard(() => callMethod(a, b, c));
            } else if (kind === "resolve") {
                let musicItem: any = null;
                let quality = "standard";
                let excludeUrl = "";
                try {
                    const parsed = a ? JSON.parse(a) : {};
                    musicItem = parsed?.item ?? parsed;
                    quality = String(parsed?.quality ?? b ?? "standard");
                    excludeUrl = String(parsed?.excludeUrl ?? c ?? "");
                } catch {
                    musicItem = null;
                }
                guard(async () => {
                    if (!musicItem) {
                        return { ok: false, reason: "音乐条目解析失败" } satisfies RuntimeResolveFail;
                    }
                    return await resolveMediaSource(musicItem, quality, excludeUrl);
                });
            } else {
                throw new Error(`未知任务类型：${kind}`);
            }
        } catch (e: any) {
            jobStateValue = "rejected";
            jobError = String(e?.message ?? e);
        }
        return id;
    };

    g.__jobState = (): string => jobStateValue;
    g.__jobResult = (): string => jobResultJson;
    g.__jobError = (): string => jobError;
    g.__jobId = (): number => job.id;
    if (typeof g.__tick !== "function") {
        g.__tick = () => undefined;
    }
}

installTaskApi();

console.log("[native-runtime] plugin runtime bundle loaded");
