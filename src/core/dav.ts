import { hasNativeHttp, nativeHttpRequest } from "./native";
import { getProxyBase, relayRequest } from "./net";

/**
 * WebDAV 客户端（轻量实现）
 *
 * 与桌面端 WebDAV 备份同通道：同一个 NAS / Nextcloud / 坚果云 账号即可互传备份。
 * 传输策略（按顺序选择可用的）：
 *  1. 原生应用：CapacitorHttp 直连（无跨域限制）；
 *  2. 配置了伴生代理：走代理 /relay（代理在电脑上代发，同样无跨域限制）；
 *  3. 浏览器直连：要求 WebDAV 服务端支持 CORS（Nextcloud / Alist 大多支持）。
 *
 * 方法兼容：Android 的 CapacitorHttp 基于 HttpURLConnection，只允许
 * GET/HEAD/POST/PUT/DELETE/OPTIONS/PATCH/TRACE 这 8 个标准方法，
 * PROPFIND / MKCOL 会被 ProtocolException 直接拒绝（真机已复现）。
 * 因此涉及扩展方法的逻辑都带标准方法回退：
 *  - 测试连接：PROPFIND → GET 文件路径；
 *  - 云端检查：PROPFIND → HEAD 文件路径；
 *  - 建目录：Android 原生层直接跳过 MKCOL（多数服务端 PUT 会自动创建父目录）。
 *
 * 认证：HTTP Basic（覆盖 Nextcloud、Alist、坚果云应用密码等绝大多数场景）。
 */

export interface IWebdavConfig {
    url: string;
    username: string;
    password: string;
    filePath: string;
}

export const DEFAULT_WEBDAV_FILE_PATH = "/MusicFree/MusicFreePadBackup.json";

const CFG_KEYS = {
    url: "backup.webdav.url",
    username: "backup.webdav.username",
    password: "backup.webdav.password",
    filePath: "backup.webdav.filePath",
};

export function getWebdavConfig(): IWebdavConfig {
    return {
        url: (localStorage.getItem(CFG_KEYS.url) ?? "").trim().replace(/\/+$/, ""),
        username: localStorage.getItem(CFG_KEYS.username) ?? "",
        password: localStorage.getItem(CFG_KEYS.password) ?? "",
        filePath:
            (localStorage.getItem(CFG_KEYS.filePath) ?? "").trim() || DEFAULT_WEBDAV_FILE_PATH,
    };
}

export function setWebdavConfig(patch: Partial<IWebdavConfig>) {
    if (patch.url !== undefined) {
        const v = patch.url.trim().replace(/\/+$/, "");
        v ? localStorage.setItem(CFG_KEYS.url, v) : localStorage.removeItem(CFG_KEYS.url);
    }
    if (patch.username !== undefined) {
        localStorage.setItem(CFG_KEYS.username, patch.username);
    }
    if (patch.password !== undefined) {
        localStorage.setItem(CFG_KEYS.password, patch.password);
    }
    if (patch.filePath !== undefined) {
        const v = patch.filePath.trim();
        v ? localStorage.setItem(CFG_KEYS.filePath, v) : localStorage.removeItem(CFG_KEYS.filePath);
    }
}

/** 上次成功上传 / 恢复的时间戳（本机状态，不进备份） */
function timeKey(kind: "upload" | "download") {
    return `backup.webdav.last${kind === "upload" ? "Upload" : "Download"}At`;
}

export function getWebdavLastAt(kind: "upload" | "download"): number | null {
    const raw = localStorage.getItem(timeKey(kind));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function setWebdavLastAt(kind: "upload" | "download") {
    localStorage.setItem(timeKey(kind), String(Date.now()));
}

/** ---------------- 底层请求 ---------------- */

interface IDavResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
}

/** HttpURLConnection 等"标准方法白名单"里没有的 WebDAV 扩展方法 */
const EXTENDED_DAV_METHODS = new Set(["PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"]);

function isExtendedDavMethod(method: string): boolean {
    return EXTENDED_DAV_METHODS.has(method.toUpperCase());
}

/** Android 原生层的 CapacitorHttp 不支持扩展方法（iOS 的 URLSession 支持） */
function isAndroidNative(): boolean {
    try {
        return (window as any).Capacitor?.getPlatform?.() === "android";
    } catch {
        return false;
    }
}

function errText(e: any): string {
    const raw = String(e?.message ?? e ?? "");
    // Android HttpURLConnection: "Expected one of [...] but was PROPFIND"
    const m = raw.match(/but was (\w+)/i);
    if (m) {
        return `当前网络层不支持 ${m[1]} 方法`;
    }
    return raw || "未知错误";
}

/**
 * Android 原生层（含被 CapacitorHttp 接管的 fetch）发不出扩展方法，
 * 且没配伴生代理时没有别的通道——调用方应直接选用标准方法，避免空跑一轮失败请求。
 */
function needsStandardMethodOnly(): boolean {
    return hasNativeHttp() && isAndroidNative() && !getProxyBase();
}

function utf8ToBase64(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
}

function authHeaders(config: IWebdavConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.username || config.password) {
        headers["Authorization"] = `Basic ${utf8ToBase64(
            `${config.username}:${config.password}`,
        )}`;
    }
    return headers;
}

function davUrl(config: IWebdavConfig, path: string): string {
    const base = config.url.replace(/\/+$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    // 路径逐段编码，保留 /
    const encoded = p
        .split("/")
        .map((seg) => (seg ? encodeURIComponent(seg) : ""))
        .join("/");
    return `${base}${encoded}`;
}

async function davRequest(
    config: IWebdavConfig,
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<IDavResponse> {
    const url = davUrl(config, path);
    const headers = {
        ...authHeaders(config),
        ...(options?.headers ?? {}),
    };
    const timeoutMs = options?.timeoutMs ?? 30000;

    // 1) 原生 HTTP：无跨域、支持任意方法（Android 除外：扩展方法会被 HttpURLConnection 拒绝）
    const nativeCanSend = hasNativeHttp() && !(isAndroidNative() && isExtendedDavMethod(method));
    if (nativeCanSend) {
        try {
            const res = await nativeHttpRequest({
                url,
                method,
                headers,
                body: options?.body,
                timeoutMs,
            });
            return res;
        } catch (e: any) {
            // 原生层失败视为网络 / 服务问题，直接抛出（避免再等一遍代理或直连超时）
            throw new Error(`WebDAV 请求失败：${errText(e)}`);
        }
    }

    // 2) 伴生代理（Android 扩展方法唯一的原生出路也在这里）
    try {
        const res = await relayRequest(url, {
            method,
            headers,
            body: options?.body,
            timeoutMs,
        });
        return res;
    } catch (e: any) {
        // 代理未配置时回退直连；配置了代理但失败则不再直连（避免超时等待加倍）
        if (getProxyBase()) {
            throw new Error(`WebDAV 请求失败：${e?.message ?? e}`);
        }
    }

    // 3) 浏览器直连（要求服务端支持 CORS）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers,
            body: options?.body,
            signal: controller.signal,
            credentials: "omit",
        });
        const text = await res.text();
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
            resHeaders[k.toLowerCase()] = v;
        });
        return { status: res.status, headers: resHeaders, text };
    } catch (e: any) {
        throw new Error(
            `WebDAV 请求失败：${e?.message ?? e}（浏览器直连被跨域拦截时，请配置伴生代理或使用原生应用）`,
        );
    } finally {
        clearTimeout(timer);
    }
}

/** 递归确保远端目录存在（逐段 MKCOL，已存在视为成功） */
async function ensureDirectory(config: IWebdavConfig, dirPath: string) {
    // Android 原生层发不出 MKCOL（HttpURLConnection 白名单方法），直接跳过：
    // 多数服务端（dufs / Alist / rclone 等）PUT 会自动创建父目录，
    // 不支持的服务端会在 PUT 时返回 409，由上传逻辑给出明确提示
    if (needsStandardMethodOnly()) {
        return;
    }
    const segments = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const seg of segments) {
        current += `/${seg}`;
        try {
            const res = await davRequest(config, "MKCOL", current, { timeoutMs: 15000 });
            const ok =
                res.status === 201 ||
                res.status === 200 ||
                res.status === 301 ||
                res.status === 405 ||
                res.status === 409; // 405=已存在，409=父目录缺失（下一层重试大多能过，部分服务器需要）
            if (!ok) {
                console.warn(`[webdav] MKCOL ${current} -> ${res.status}`);
            }
        } catch {
            // 单段失败不中断：目录多半已存在，上传时才真正校验
        }
    }
}

/** ---------------- 对外 API ---------------- */

export interface IWebdavTestResult {
    ok: boolean;
    message: string;
}

export async function testWebdav(config?: Partial<IWebdavConfig>): Promise<IWebdavTestResult> {
    const cfg = { ...getWebdavConfig(), ...(config ?? {}) } as IWebdavConfig;
    if (!cfg.url) {
        return { ok: false, message: "请填写服务器地址" };
    }
    if (!/^https?:\/\//i.test(cfg.url)) {
        return { ok: false, message: "地址需要以 http(s):// 开头" };
    }
    // 首选 PROPFIND（标准 WebDAV 检测）；Android 原生层等发不出 PROPFIND 的环境
    // 直接走 GET 文件路径（未认证时服务端应返回 401，同样能验证账号）
    if (!needsStandardMethodOnly()) {
        try {
            const res = await davRequest(cfg, "PROPFIND", "/", {
                headers: { Depth: "0" },
                timeoutMs: 12000,
            });
            if (res.status >= 200 && res.status < 400) {
                return { ok: true, message: "连接成功" };
            }
            if (res.status === 401) {
                return { ok: false, message: "认证失败：检查用户名 / 密码" };
            }
            if (res.status === 404) {
                return { ok: true, message: "连接成功（目录暂不存在，上传时会自动创建）" };
            }
            return { ok: false, message: `服务器响应 ${res.status}` };
        } catch {
            // fallthrough：改用 GET 做兼容检测
        }
    }
    try {
        const res = await davRequest(cfg, "GET", cfg.filePath, { timeoutMs: 12000 });
        if (res.status >= 200 && res.status < 400) {
            return { ok: true, message: "连接成功" };
        }
        if (res.status === 401) {
            return { ok: false, message: "认证失败：检查用户名 / 密码" };
        }
        if (res.status === 404) {
            return { ok: true, message: "连接成功（云端暂无备份文件，上传时自动创建）" };
        }
        return { ok: false, message: `服务器响应 ${res.status}` };
    } catch (e: any) {
        return { ok: false, message: e?.message ?? "连接失败" };
    }
}

/** 上传备份内容到 WebDAV（自动创建目录，返回云端路径） */
export async function uploadBackupToWebdav(content: string): Promise<{ remotePath: string }> {
    const cfg = getWebdavConfig();
    if (!cfg.url) {
        throw new Error("请先在下方填写 WebDAV 服务器信息");
    }
    const dir = cfg.filePath.slice(0, cfg.filePath.lastIndexOf("/")) || "/";
    if (dir && dir !== "/") {
        await ensureDirectory(cfg, dir);
    }
    const res = await davRequest(cfg, "PUT", cfg.filePath, {
        headers: { "Content-Type": "application/json" },
        body: content,
        timeoutMs: 60000,
    });
    if (res.status >= 200 && res.status < 300) {
        setWebdavLastAt("upload");
        return { remotePath: cfg.filePath };
    }
    if (res.status === 409) {
        throw new Error(
            "上传失败（409）：远端目录不存在，且该服务器不支持自动创建目录，请先在服务器上建好对应目录",
        );
    }
    if (res.status === 401) {
        throw new Error("上传失败：认证失败，检查用户名 / 密码");
    }
    throw new Error(`上传失败（${res.status}）：检查账号权限与文件路径`);
}

/** 从 WebDAV 下载备份内容；云端没有文件时抛出带标识的错误 */
export async function downloadBackupFromWebdav(): Promise<{ content: string; remotePath: string }> {
    const cfg = getWebdavConfig();
    if (!cfg.url) {
        throw new Error("请先在下方填写 WebDAV 服务器信息");
    }
    const res = await davRequest(cfg, "GET", cfg.filePath, { timeoutMs: 60000 });
    if (res.status === 404) {
        throw new Error(`云端没有备份文件（${cfg.filePath}），先在桌面端或本机上传一份`);
    }
    if (res.status === 401) {
        throw new Error("认证失败：检查用户名 / 密码");
    }
    if (!(res.status >= 200 && res.status < 300)) {
        throw new Error(`下载失败（${res.status}）`);
    }
    if (!res.text?.length) {
        throw new Error("云端备份文件为空");
    }
    setWebdavLastAt("download");
    return { content: res.text, remotePath: cfg.filePath };
}

/** 检查云端备份是否存在（恢复前提示用） */
export async function checkWebdavBackupExists(): Promise<{
    exists: boolean;
    lastModified?: string;
    size?: number;
}> {
    const cfg = getWebdavConfig();
    if (!cfg.url) {
        return { exists: false };
    }
    // PROPFIND 优先（能带出 lastModified / size）；发不出去（Android 原生层）时用 HEAD
    const methods = needsStandardMethodOnly() ? ["HEAD"] : ["PROPFIND", "HEAD"];
    for (const method of methods) {
        try {
            const res = await davRequest(cfg, method, cfg.filePath, {
                headers: method === "PROPFIND" ? { Depth: "0" } : undefined,
                timeoutMs: 15000,
            });
            if (res.status >= 200 && res.status < 300) {
                const lastModified = res.headers["lastmodified"] ?? res.headers["last-modified"];
                const size = Number(res.headers["contentlength"] ?? res.headers["content-length"]);
                return {
                    exists: true,
                    lastModified,
                    size: Number.isFinite(size) ? size : undefined,
                };
            }
            if (res.status === 404) {
                return { exists: false };
            }
            // 其他状态（401 / 403 等）：换下一个方法再确认一次
        } catch {
            // 传输层失败：换下一个方法
        }
    }
    return { exists: false };
}
