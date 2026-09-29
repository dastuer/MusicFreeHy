/**
 * 插件沙箱（Web Worker）
 *
 * 与 MusicFreeDesktop 的 electron/services/pluginHost.ts 保持同一套挂载逻辑：
 * CommonJS 风格插件代码 + Function 构造器沙箱 + 白名单 require。
 * 差异点：
 *  - 运行环境从 Node 主进程换成 Web Worker；
 *  - 网络层用 fetch 实现 axios 适配器，可按需路由到伴生代理（解决跨域/自定义请求头）；
 *  - 插件结果序列化后回传主线程（等价于桌面端的 IPC 序列化过滤）。
 */

import axios from "axios";
import * as cheerio from "cheerio";
import CryptoJs from "crypto-js";
import dayjs from "dayjs";
import bigInt from "big-integer";
import qs from "qs";
import he from "he";
import { satisfies, compare } from "compare-versions";

/** satisfies 版本检查用的基准版本（与桌面端同机制，数值对齐桌面端 1.0.0） */
const APP_VERSION = "1.0.0";

const sha256 = (s: string) => CryptoJs.SHA256(s).toString();

const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage: (msg: any) => void;
};

function post(msg: any) {
    ctx.postMessage(msg);
}

/** ---------------- 网络层 ---------------- */

let proxyBase = "";
/** 原生应用（Capacitor）环境：插件请求经主线程的原生 HTTP 中转（无跨域限制） */
let nativeHttp = false;

/** 简易 URL 参数序列化（覆盖插件的常规用法：扁平对象 / 数组） */
function buildUrl(url: string, params: any, paramsSerializer?: any): string {
    if (!params) {
        return url;
    }
    if (typeof paramsSerializer === "function") {
        return `${url}${url.includes("?") ? "&" : "?"}${paramsSerializer(params)}`;
    }
    const parts: string[] = [];
    const encode = (v: string) =>
        encodeURIComponent(v)
            .replace(/%20/g, "+")
            .replace(/%3A/g, ":")
            .replace(/%24/g, "$")
            .replace(/%2C/g, ",")
            .replace(/%2B/g, "+");
    const visit = (value: any, key: string) => {
        if (value === null || value === undefined) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((el) => visit(el, `${key}[]`));
        } else if (typeof value === "object") {
            Object.entries(value).forEach(([k, v]) => visit(v, `${key}[${k}]`));
        } else {
            parts.push(`${encode(key)}=${encode(String(value))}`);
        }
    };
    Object.entries(params).forEach(([k, v]) => visit(v, k));
    if (!parts.length) {
        return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

function normalizeHeaders(input: any): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input) {
        return out;
    }
    const raw = typeof input.toJSON === "function" ? input.toJSON() : input;
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined || value === null) {
            continue;
        }
        out[key] = String(value);
    }
    return out;
}

async function readResponseData(res: Response, responseType?: string) {
    switch (responseType) {
        case "arraybuffer":
            return await res.arrayBuffer();
        case "blob":
            return await res.blob();
        case "text":
        case "document":
        case "stream":
            return await res.text();
        default: {
            // axios 默认（undefined / json）：先按 JSON 解析，失败给原文
            const text = await res.text();
            if (!text.length) {
                return "";
            }
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }
    }
}

function makeAxiosError(message: string, config: any, response?: any) {
    const err: any = new Error(message);
    err.isAxiosError = true;
    err.config = config;
    if (response) {
        err.response = response;
    }
    err.toJSON = () => ({
        message,
        name: err.name,
        status: response?.status,
    });
    return err;
}

/** 原生模式：把请求转发给主线程执行（主线程通过 CapacitorHttp 走原生网络栈） */
const pendingNet = new Map<
    number,
    {
        resolve: (v: { status: number; headers: Record<string, string>; text: string }) => void;
        reject: (e: any) => void;
    }
>();
let netSeq = 0;

function hostFetch(req: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
}): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    return new Promise((resolve, reject) => {
        const id = ++netSeq;
        const timer = setTimeout(() => {
            pendingNet.delete(id);
            reject(new Error("宿主网络请求超时"));
        }, 45000);
        pendingNet.set(id, {
            resolve: (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            reject: (e) => {
                clearTimeout(timer);
                reject(e);
            },
        });
        post({ type: "net", netId: id, req });
    });
}

/** 文本响应按 responseType 解析（原生中继分支用） */
function parseTextData(text: string, responseType?: string) {
    if (responseType === "text" || responseType === "document" || responseType === "stream") {
        return text;
    }
    if (!text.length) {
        return "";
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * axios 适配器：
 *  - 未配置伴生代理：直接 fetch（音源接口允许跨域时可用）；
 *  - 配置了伴生代理：全部请求转发到 `POST {proxy}/relay`，由代理在无跨域限制的环境里代发。
 */
function proxyAdapter(config: any): Promise<any> {
    if (config.cancelToken?.reason) {
        return Promise.reject(config.cancelToken.reason);
    }
    if (config.signal?.aborted) {
        return Promise.reject(makeAxiosError("canceled", config));
    }

    const method = (config.method ?? "get").toUpperCase();
    const fullUrl = buildUrl(
        (config.baseURL ?? "") + config.url,
        config.params,
        config.paramsSerializer,
    );

    const headers = normalizeHeaders(config.headers);
    let body: any = config.data;
    if (body !== undefined && body !== null && typeof body !== "string") {
        if (
            body instanceof URLSearchParams ||
            body instanceof FormData ||
            body instanceof ArrayBuffer
        ) {
            // 原样透传
        } else {
            body = JSON.stringify(body);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
                headers["Content-Type"] = "application/json";
            }
        }
    }

    const controller = new AbortController();
    const timeout = config.timeout && config.timeout > 0 ? config.timeout : 20000;
    const timer = setTimeout(
        () => controller.abort(new Error(`timeout of ${timeout}ms exceeded`)),
        timeout,
    );
    const onAbort = () => controller.abort(new Error("canceled"));
    config.signal?.addEventListener("abort", onAbort);
    config.cancelToken?.promise.then(onAbort).catch(() => undefined);

    try {
        const request = async (): Promise<any> => {
            if (proxyBase) {
                const relayRes = await fetch(`${proxyBase.replace(/\/+$/, "")}/relay`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    signal: controller.signal,
                    body: JSON.stringify({
                        url: fullUrl,
                        method,
                        headers,
                        body: typeof body === "string" ? body : undefined,
                        responseType: config.responseType === "arraybuffer" ? "base64" : "text",
                    }),
                });
                if (!relayRes.ok) {
                    throw makeAxiosError(`代理请求失败 (${relayRes.status})`, config);
                }
                const payload = await relayRes.json();
                if (payload.error) {
                    throw makeAxiosError(String(payload.error), config);
                }
                const data =
                    payload.encoding === "base64"
                        ? Uint8Array.from(atob(payload.data ?? ""), (c) =>
                              c.charCodeAt(0),
                          ).buffer
                        : payload.data;
                const response = {
                    data,
                    status: payload.status ?? 200,
                    statusText: payload.statusText ?? "",
                    headers: payload.headers ?? {},
                    config,
                };
                const validate = config.validateStatus;
                if (!validate || validate(response.status)) {
                    return response;
                }
                throw makeAxiosError(
                    `Request failed with status code ${response.status}`,
                    config,
                    response,
                );
            }

            if (nativeHttp) {
                // 原生应用：无伴生代理时走宿主原生 HTTP（跨域与自定义请求头都不受限）
                const res = await hostFetch({
                    url: fullUrl,
                    method,
                    headers,
                    body: typeof body === "string" ? body : undefined,
                });
                const response = {
                    data: parseTextData(res.text, config.responseType),
                    status: res.status,
                    statusText: "",
                    headers: res.headers,
                    config,
                };
                const validate = config.validateStatus;
                if (!validate || validate(response.status)) {
                    return response;
                }
                throw makeAxiosError(
                    `Request failed with status code ${response.status}`,
                    config,
                    response,
                );
            }

            const res = await fetch(fullUrl, {
                method,
                headers,
                body: method === "GET" || method === "HEAD" ? undefined : body,
                signal: controller.signal,
                // 音源接口基本不支持 CORS 预检，凭据一律不带
                credentials: "omit",
            });
            const data = await readResponseData(res, config.responseType);
            const responseHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => {
                responseHeaders[k] = v;
            });
            const response = {
                data,
                status: res.status,
                statusText: res.statusText,
                headers: responseHeaders,
                config,
            };
            const validate = config.validateStatus;
            if (!validate || validate(response.status)) {
                return response;
            }
            throw makeAxiosError(
                `Request failed with status code ${response.status}`,
                config,
                response,
            );
        };

        return request().finally(() => {
            clearTimeout(timer);
            config.signal?.removeEventListener("abort", onAbort);
        }) as Promise<any>;
    } catch (e: any) {
        clearTimeout(timer);
        if (e?.isAxiosError) {
            return Promise.reject(e);
        }
        return Promise.reject(
            makeAxiosError(
                proxyBase
                    ? `代理网络错误：${e?.message ?? e}`
                    : `网络错误（音源接口可能不支持跨域，可在设置里配置伴生代理）：${
                          e?.message ?? e
                      }`,
                config,
            ),
        );
    }
}

axios.defaults.adapter = proxyAdapter as any;
axios.defaults.timeout = 20000;

/** 与桌面端一致：把单条 set-cookie 暴露成 x-set-cookie，部分插件会读它 */
axios.interceptors.response.use((response) => {
    const setCookie = (response.headers as any)?.["set-cookie"];
    if (Array.isArray(setCookie) && setCookie.length === 1) {
        (response.headers as any)["x-set-cookie"] = setCookie;
    }
    return response;
});

/** ---------------- 插件可用依赖（与桌面端白名单一致） ---------------- */

const packages: Record<string, any> = {
    cheerio,
    "crypto-js": CryptoJs,
    axios,
    dayjs,
    "big-integer": bigInt,
    qs,
    he,
    "@react-native-cookies/cookies": {
        get: () => null,
        set: () => null,
        flush: () => null,
    },
    // 浏览器端不实际支持 WebDAV：保留包名占位，避免个别插件 require 时直接崩掉
    webdav: new Proxy(
        {},
        {
            get() {
                return () => {
                    throw new Error("Pad 版暂不支持 WebDAV");
                };
            },
        },
    ),
    "compare-versions": { satisfies, compare },
};

const _require = (packageName: string) => {
    const pkg = packages[packageName];
    if (!pkg) {
        throw new Error(`package not supported: ${packageName}`);
    }
    try {
        pkg.default = pkg;
        return pkg;
    } catch {
        // Vite 产物下 import * as 的 ESM 命名空间（cheerio 等）只读，不能挂 default：
        // 包一层补上，兼容插件 require('x').default 的桌面端用法
        return { ...pkg, default: pkg };
    }
};

const _console = {
    log: (...args: any[]) => console.log("[plugin]", ...args),
    warn: (...args: any[]) => console.warn("[plugin]", ...args),
    info: (...args: any[]) => console.info("[plugin]", ...args),
    error: (...args: any[]) => console.error("[plugin]", ...args),
};

/** ---------------- 插件挂载 ---------------- */

interface MountedPlugin {
    instance: any;
    userVariablesRef: { current: Record<string, string> };
}

const mounted = new Map<string, MountedPlugin>();

/**
 * 序列化插件结果（对齐桌面端 IPC 序列化行为）：
 *  - 函数/Symbol 置空、undefined 字段丢弃；
 *  - 真循环引用断开为 null（用「祖先栈」判定，只有还挂在当前递归链上的对象才算环）；
 *  - 共享引用（同一对象出现在多处，如酷我插件 pinned 与分组里的同一标签）原样保留为重复数据。
 *    注意不能用全局 seen 集合：会把共享引用误判成环写成 null，上游渲染 {item.title} 直接崩。
 */
function serializeValue(value: any, ancestors: Set<object>): any {
    if (typeof value === "function" || typeof value === "symbol") {
        return null;
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (ancestors.has(value)) {
        return null;
    }
    const toJSON = (value as any).toJSON;
    if (typeof toJSON === "function") {
        return serializeValue(toJSON.call(value), ancestors);
    }
    ancestors.add(value);
    const isArray = Array.isArray(value);
    const out: Record<string, any> = isArray ? [] : {};
    for (const key of Object.keys(value)) {
        const serialized = serializeValue(value[key], ancestors);
        if (serialized === undefined) {
            if (isArray) {
                out[key] = null;
            }
            continue;
        }
        out[key] = serialized;
    }
    ancestors.delete(value);
    return out;
}

/** 序列化插件结果：函数/Symbol 置空、循环引用断开（对齐桌面端 IPC 序列化行为） */
function sanitize(result: any) {
    try {
        return serializeValue(result, new Set());
    } catch {
        return null;
    }
}

/** 超过该长度的 data: 封面转成会话级 blob 链接（对齐桌面端 coverCache 的动机） */
const MAX_INLINE_ARTWORK = 64 * 1024;

function dataUrlToBlobUrl(dataUrl: string): string | null {
    try {
        const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/.exec(dataUrl);
        if (!match) {
            return null;
        }
        const mime = match[1] || "image/png";
        const isBase64 = /;base64/i.test(match[2] ?? "");
        const raw = match[3];
        let bytes: Uint8Array;
        if (isBase64) {
            const bin = atob(raw);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) {
                bytes[i] = bin.charCodeAt(i);
            }
        } else {
            bytes = new TextEncoder().encode(decodeURIComponent(raw));
        }
        return URL.createObjectURL(new Blob([bytes as any], { type: mime }));
    } catch {
        return null;
    }
}

/** 给插件返回的媒体项补 platform / coverImg→artwork / 大体积内联封面转短链 */
function patchResultPlatform(result: any, platform: string, depth = 0) {
    if (!result || typeof result !== "object" || depth > 3) {
        return;
    }
    if (Array.isArray(result)) {
        result.forEach((el) => patchResultPlatform(el, platform, depth + 1));
        return;
    }
    const patchItem = (item: any) => {
        if (item && typeof item === "object") {
            if (!item.platform) {
                item.platform = platform;
            }
            if (!item.artwork && item.coverImg) {
                item.artwork = item.coverImg;
            }
            if (
                typeof item.artwork === "string" &&
                item.artwork.startsWith("data:") &&
                item.artwork.length > MAX_INLINE_ARTWORK
            ) {
                const link = dataUrlToBlobUrl(item.artwork);
                item.artwork = link ?? "";
            }
        }
    };
    if (result.id && result.title) {
        patchItem(result);
    }
    ["data", "musicList", "pinned"].forEach((key) => {
        if (Array.isArray(result[key])) {
            result[key].forEach(patchItem);
        }
    });
}

export interface PluginMountInfo {
    name: string;
    hash: string;
    version: string;
    srcUrl: string;
    author: string;
    description: string;
    userVariablesDef?: any;
    supportedMethods: string[];
    state: "Mounted" | "Error";
    errorReason?: string;
}

/** 挂载插件代码；成功时同时登记实例，失败时给 errorReason */
function mountPlugin(code: string, userVariables: Record<string, string>): PluginMountInfo {
    let instance: any;
    let errorReason: string | undefined;
    const userVariablesRef = { current: userVariables };
    const env = {
        getUserVariables: () => userVariablesRef.current,
        get userVariables() {
            return this.getUserVariables() ?? {};
        },
        appVersion: APP_VERSION,
        os: "ios",
        lang: "zh-CN",
    };
    const _process = {
        platform: "ios",
        version: APP_VERSION,
        env,
    };
    const _module: any = { exports: {} };

    try {
        instance = Function(
            `
                'use strict';
                return function(require, __musicfree_require, module, exports, console, env, URL, process) {
                    ${code}
                }
            `,
        )()(_require, _require, _module, _module.exports, _console, env, URL, _process);
        if (_module.exports.default) {
            instance = _module.exports.default;
        } else if (!instance) {
            instance = _module.exports;
        }
        if (Array.isArray(instance.userVariables)) {
            instance.userVariables = instance.userVariables.filter((it: any) => it?.key);
        }
        if (instance.appVersion && !satisfies(APP_VERSION, instance.appVersion)) {
            throw { instance, errorReason: "VersionNotMatch" };
        }
    } catch (e: any) {
        // 带上真实报错：挂载失败时用户能在插件管理/恢复结果里看到具体原因
        errorReason = e?.errorReason ?? `CannotParse（${e?.message ?? e}）`;
        instance = e?.instance ?? {
            platform: "",
            async getMediaSource() {
                return null;
            },
            async search() {
                return {};
            },
        };
    }

    const name = instance?.platform ?? "";
    const hash = name && !errorReason ? sha256(code) : "";
    if (!name) {
        errorReason = errorReason ?? "CannotParse";
    }

    if (hash) {
        mounted.set(hash, { instance, userVariablesRef });
    }

    return {
        name,
        hash,
        version: instance?.version ?? "",
        srcUrl: instance?.srcUrl ?? "",
        author: instance?.author ?? "",
        description: instance?.description ?? "",
        userVariablesDef: instance?.userVariables,
        supportedMethods: Object.keys(instance ?? {}).filter(
            (key) => typeof instance[key] === "function",
        ),
        state: hash ? "Mounted" : "Error",
        errorReason,
    };
}

/** ---------------- 消息处理 ---------------- */

ctx.onmessage = async (ev: MessageEvent) => {
    const msg = ev.data ?? {};
    try {
        switch (msg.type) {
            case "init": {
                proxyBase = typeof msg.proxyBase === "string" ? msg.proxyBase : "";
                nativeHttp = !!msg.nativeHttp;
                post({ type: "result", id: msg.id, ok: true, data: { ready: true } });
                break;
            }
            case "mount": {
                const info = mountPlugin(msg.code, {});
                post({ type: "result", id: msg.id, ok: true, data: info });
                break;
            }
            case "unmount": {
                if (msg.hash) {
                    mounted.delete(msg.hash);
                }
                break;
            }
            case "setUserVariables": {
                const st = mounted.get(msg.hash);
                if (st) {
                    st.userVariablesRef.current = msg.userVariables ?? {};
                }
                break;
            }
            case "call": {
                const st = mounted.get(msg.hash);
                if (!st || !st.instance) {
                    throw new Error("插件不存在或未挂载");
                }
                const fn = st.instance[msg.method];
                if (typeof fn !== "function") {
                    throw new Error(`插件不支持 ${msg.method}`);
                }
                let result = await fn.apply(st.instance, msg.args ?? []);
                result = sanitize(result);
                patchResultPlatform(result, st.instance.platform);
                post({ type: "result", id: msg.id, ok: true, data: result });
                break;
            }
            case "netResult": {
                // 宿主代发的网络请求回包（原生模式）
                const p = pendingNet.get(msg.netId);
                if (p) {
                    pendingNet.delete(msg.netId);
                    if (msg.ok) {
                        p.resolve(msg.payload);
                    } else {
                        p.reject(new Error(msg.error ?? "宿主网络请求失败"));
                    }
                }
                break;
            }
            default:
                break;
        }
    } catch (e: any) {
        // netResult 异常没有所属的调用 id，回一个 0 号占位（宿主不会匹配到）
        post({
            type: "result",
            id: msg?.id ?? 0,
            ok: false,
            error: e?.message ?? String(e ?? "插件调用失败"),
        });
    }
};

post({ type: "workerLoaded" });
