/**
 * 插件沙箱（Web Worker）
 *
 * 与 MusicFreeDesktop 的 electron/services/pluginHost.ts 保持同一套挂载逻辑：
 * CommonJS 风格插件代码 + Function 构造器沙箱 + 白名单 require。
 * 差异点：
 *  - 运行环境从 Node 主进程换成 Web Worker；
 *  - 网络层用 fetch 实现 axios 适配器，可按需路由到伴生代理（解决跨域/自定义请求头）；
 *  - 插件结果序列化后回传主线程（等价于桌面端 IPC 序列化过滤）。
 *
 * 挂载 / 序列化 / 依赖白名单的纯逻辑抽在 pluginSandboxCore.ts，
 * 与原生 QuickJS 运行时（src/native/nativeRuntimeEntry.ts）共用。
 */

import axios from "axios";
import {
    buildUrl,
    makeAxiosError,
    mountPlugin,
    normalizeHeaders,
    patchResultPlatform,
    parseTextData,
    requirePackage,
    sanitize,
    type MountedPlugin,
} from "./pluginSandboxCore";

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
                // 原生应用：插件请求一律走宿主原生 HTTP（CapacitorHttp），与桌面端
                // （Electron 主进程 Node 栈）同为「全原生栈」，行为才能对齐。
                // 不能优先走 Worker 内 fetch（浏览器栈）：浏览器会静默丢弃插件显式
                // 设置的 User-Agent / Referer / Cookie（fetch 受限头），对 CORS 放行的
                // 音源主机（如酷我 nmobi.kuwo.cn）这类「缺头」请求会成功返回并被采用，
                // 后端按未授信客户端处理 —— VIP 歌曲整条解析链失败后落到网易
                // outer-url 兜底，返回的正是 30s 试听直链（只播 30 秒、下载同样失效）。
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

            return await doFetch();
        };

        /** 浏览器栈请求（Worker 内 fetch，凭据不带；受 CORS 限制；仅浏览器/代理环境用） */
        async function doFetch(): Promise<any> {
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
        }

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

/** ---------------- 插件挂载 ---------------- */

const mounted = new Map<string, MountedPlugin>();

/** 消息处理 */

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
                const info = mountPlugin(msg.code, {}, (hash, entry) => mounted.set(hash, entry));
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
