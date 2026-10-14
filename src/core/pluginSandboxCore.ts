/**
 * 插件沙箱「与环境无关」的那部分逻辑（挂载 / 序列化 / 依赖白名单 / 网络小工具）
 *
 * 抽出来的原因：同一套挂载语义要跑在两处——
 *  - WebView Worker（pluginWorker.ts，网络经 postMessage 中转）；
 *  - 原生 QuickJS 运行时（src/native/nativeRuntimeEntry.ts，网络走同步宿主函数），
 *    后者让音源解析不再依赖 WebView JS 存活（后台连播的根治）。
 * 两处共用本模块，避免「原生解析结果与 WebView 解析结果不一致」这类漂移。
 *
 * 本模块禁止引用任何环境全局（self / window / fetch / postMessage…），
 * 只允许纯逻辑 + 依赖白名单里的库。
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
export const APP_VERSION = "1.0.0";

export const sha256 = (s: string) => CryptoJs.SHA256(s).toString();

/** ---------------- 网络小工具（与环境无关的部分） ---------------- */

/** 简易 URL 参数序列化（覆盖插件的常规用法：扁平对象 / 数组） */
export function buildUrl(url: string, params: any, paramsSerializer?: any): string {
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

export function normalizeHeaders(input: any): Record<string, string> {
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

/** 文本响应按 responseType 解析（原生中继分支用） */
export function parseTextData(text: string, responseType?: string) {
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

export function makeAxiosError(message: string, config: any, response?: any) {
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

/** ---------------- 插件可用依赖（与桌面端白名单一致） ---------------- */

export const packages: Record<string, any> = {
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

export const requirePackage = (packageName: string) => {
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

export const pluginConsole = {
    log: (...args: any[]) => console.log("[plugin]", ...args),
    warn: (...args: any[]) => console.warn("[plugin]", ...args),
    info: (...args: any[]) => console.info("[plugin]", ...args),
    error: (...args: any[]) => console.error("[plugin]", ...args),
};

/** ---------------- 结果序列化 / 平台补丁 ---------------- */

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
export function sanitize(result: any) {
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
        const creator = (globalThis as any).URL?.createObjectURL;
        if (typeof creator !== "function") {
            // 原生 QuickJS 没有 blob URL：退回空串（封面缺失，不影响播放链路）
            return "";
        }
        return creator(new Blob([bytes as any], { type: mime }));
    } catch {
        return null;
    }
}

/** 给插件返回的媒体项补 platform / coverImg→artwork / 大体积内联封面转短链 */
export function patchResultPlatform(result: any, platform: string, depth = 0) {
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

/** ---------------- 插件挂载 ---------------- */

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

export interface MountedPlugin {
    instance: any;
    userVariablesRef: { current: Record<string, string> };
}

/**
 * 挂载插件代码（CommonJS 风格 + Function 构造器沙箱）。
 * 成功时回调 register(hash, entry) 登记实例；失败时返回的 info 带 errorReason。
 */
export function mountPlugin(
    code: string,
    userVariables: Record<string, string>,
    register?: (hash: string, entry: MountedPlugin) => void,
): PluginMountInfo {
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
        )()(requirePackage, requirePackage, _module, _module.exports, pluginConsole, env, URL, _process);
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

    if (hash && register) {
        register(hash, { instance, userVariablesRef });
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
