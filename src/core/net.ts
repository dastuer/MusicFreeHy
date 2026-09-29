/**
 * 网络辅助：伴生代理（可选，仅浏览器）+ 媒体链接构造
 *
 * 浏览器环境没有桌面端 mfs:// 自定义协议那层代理。插件的 API 请求可能被
 * CORS 拦截、媒体直链可能需要特定请求头，这里提供一个可选的伴生代理通道：
 *  - 项目自带 `npm run proxy` 起一个本地转发服务，把地址填进设置页即可；
 *  - 未配置时，插件请求直接 fetch（多数源可用），媒体直链原样交给 <audio>。
 *
 * 原生应用（Android / iOS）走 CapacitorHttp 系统网络栈，无跨域与请求头限制，
 * 不需要也不使用伴生代理：配置值即使存在（如备份恢复带入）也一律忽略，
 * 设置页只在浏览器环境展示该配置项。
 */

import { b64urlEncode } from "./ipc";
import { isNative } from "./native";

export const PROXY_BASE_KEY = "mediaProxy.base";

/** 伴生代理 /ping 返回的服务标识 */
export const PROXY_SERVICE = "musicfree-pad-proxy";

/** 同源内置代理探测结果（detectProxy 写入；仅浏览器会话内有效） */
let builtinProxyBase = "";

const BUILTIN_PROXY_KEY = "mediaProxy.builtinOrigin";

function explicitProxyBase(): string {
    try {
        return (localStorage.getItem(PROXY_BASE_KEY) ?? "").replace(/\/+$/, "");
    } catch {
        return "";
    }
}

export function getProxyBase(): string {
    if (isNative()) {
        return "";
    }
    return explicitProxyBase() || builtinProxyBase;
}

/**
 * 浏览器启动时探测同源内置代理（`npm run dev` / `npm run preview` 通过
 * server/proxyCore.mjs 在同源挂载 /ping /relay /media，打开页面即自动可用）。
 * 手动配置过的伴生代理优先；探测失败（纯静态部署）保持无代理直连，行为不变。
 * 必须在首次插件调用 / WebDAV 请求之前 await（main.tsx 里先于 render 执行）。
 */
export async function detectProxy(): Promise<void> {
    if (isNative() || typeof window === "undefined") {
        return;
    }
    if (explicitProxyBase()) {
        return;
    }
    const origin = window.location.origin;
    if (!/^https?:/.test(origin)) {
        return;
    }
    try {
        if (sessionStorage.getItem(BUILTIN_PROXY_KEY) === origin) {
            builtinProxyBase = origin;
            return;
        }
    } catch {
        // sessionStorage 不可用就走完整探测
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("探测超时")), 2500);
    try {
        const res = await fetch(`${origin}/ping`, { signal: controller.signal });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.service === PROXY_SERVICE) {
            builtinProxyBase = origin;
            try {
                sessionStorage.setItem(BUILTIN_PROXY_KEY, origin);
            } catch {
                // ignore
            }
        }
    } catch {
        // 没有内置代理：保持直连
    } finally {
        clearTimeout(timer);
    }
}

export function setProxyBase(value: string) {
    const trimmed = (value ?? "").trim().replace(/\/+$/, "");
    if (trimmed) {
        localStorage.setItem(PROXY_BASE_KEY, trimmed);
    } else {
        localStorage.removeItem(PROXY_BASE_KEY);
    }
}

export interface IRelayOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

/**
 * 通过伴生代理发起一次 HTTP 请求，返回 {status, headers, text}。
 * 代理挂掉 / 未配置时抛错，由调用方决定是否回退直连。
 */
export async function relayRequest(url: string, options?: IRelayOptions) {
    const proxyBase = getProxyBase();
    if (!proxyBase) {
        throw new Error("未配置伴生代理");
    }
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error("代理请求超时")),
        options?.timeoutMs ?? 30000,
    );
    try {
        const res = await fetch(`${proxyBase}/relay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                url,
                method: options?.method ?? "GET",
                headers: options?.headers,
                body: options?.body,
                responseType: "text",
            }),
        });
        if (!res.ok) {
            throw new Error(`代理请求失败 (${res.status})`);
        }
        const payload = await res.json();
        if (payload.error) {
            throw new Error(String(payload.error));
        }
        return {
            status: payload.status ?? 200,
            headers: payload.headers ?? {},
            text: String(payload.data ?? ""),
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 拉一段文本（插件源码 / 歌词 / 聚合源）：
 * 配了代理就先走代理，失败回退直连；没配代理直接 fetch。
 */
export async function netFetchText(url: string, timeoutMs = 30000): Promise<string> {
    if (getProxyBase()) {
        try {
            const relayed = await relayRequest(url, { timeoutMs });
            return relayed.text;
        } catch (e) {
            console.warn("[net] 代理请求失败，回退直连", e);
        }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
        if (!res.ok) {
            throw new Error(`请求失败 (${res.status})`);
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 构造 <audio> 可用的播放地址：
 *  - 直链无特殊请求头：原样返回（媒体元素加载跨域资源不受 CORS 限制）；
 *  - 直链带请求头（Referer / UA / Cookie）：浏览器无法给 <audio> 塞头，
 *    配了伴生代理时走 `/media` 转发；没配就只能原样试（部分源不带头也能放）。
 */
export function buildPlayableMediaUrl(payload: {
    url: string;
    headers?: Record<string, string>;
    userAgent?: string;
}): string {
    const { url } = payload;
    const headers: Record<string, string> = { ...(payload.headers ?? {}) };
    if (payload.userAgent && !Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) {
        headers["User-Agent"] = payload.userAgent;
    }
    const needsHeaders = Object.keys(headers).length > 0;
    const proxyBase = getProxyBase();
    if (needsHeaders && proxyBase) {
        return `${proxyBase}/media?u=${b64urlEncode(url)}&h=${b64urlEncode(
            JSON.stringify(headers),
        )}`;
    }
    return url;
}

/** 测试伴生代理连通性 */
export async function testProxy(base?: string): Promise<{ ok: boolean; message: string }> {
    const target = (base ?? getProxyBase()).replace(/\/+$/, "");
    if (!target) {
        return { ok: false, message: "请先填写代理地址" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("连接超时")), 8000);
    try {
        const res = await fetch(`${target}/ping`, { signal: controller.signal });
        if (!res.ok) {
            return { ok: false, message: `代理响应异常 (${res.status})` };
        }
        const data = await res.json().catch(() => null);
        if (data?.service === PROXY_SERVICE) {
            return { ok: true, message: "代理连接成功" };
        }
        return { ok: false, message: "这不是 MusicFree Pad 伴生代理" };
    } catch (e: any) {
        return { ok: false, message: e?.message ?? "无法连接代理" };
    } finally {
        clearTimeout(timer);
    }
}
