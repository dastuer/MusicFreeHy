/**
 * 伴生代理核心逻辑（独立进程 `npm run proxy` 与 Vite dev/preview 中间件共用）
 *
 * 浏览器环境没有桌面端 mfs:// 协议那层代理：
 *  - 插件的音源接口 / 插件源码下载 / WebDAV 备份可能被 CORS 拦截；
 *  - 部分歌曲直链需要 Referer / User-Agent / Cookie 才能播放，<audio> 无法带请求头。
 *
 * 提供三个端点：
 *  - GET  /ping                                          健康检查（前端自动探测用）
 *  - POST /relay    {url, method, headers, body, responseType}   转发普通请求
 *  - GET  /media?u=<b64url>&h=<b64url(json headers)>        转发媒体流（透传 Range）
 *
 * Vite 场景（`createViteProxyPlugin`）里它们挂在 dev / preview 服务器同源上，
 * 浏览器打开页面即自动可用，无需再单独起进程或手工填地址。
 */

import net from "node:net";
import tls from "node:tls";

export const PROXY_SERVICE = "musicfree-pad-proxy";

const b64urlDecode = (s) =>
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, X-Requested-With");
    res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    );
}

function readBody(req, limit = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error("请求体过大"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

/** 用原始 socket 转发单次请求（可携带任意 Host/Referer 等头，不受 Node fetch 限制；https 上游走 tls） */
function singleRawRequest({
    protocol,
    host,
    port,
    path,
    method,
    headers,
    body,
    timeoutMs = 30000,
}) {
    return new Promise((resolve, reject) => {
        const isHttps = protocol === "https:";
        const socket = isHttps
            ? tls.connect({ host, port, servername: host }, () => {
                  onConnected();
              })
            : net.connect({ host, port }, () => {
                  onConnected();
              });

        function onConnected() {            let header = `${method} ${path} HTTP/1.1\r\n`;
            const mergedHeaders = {
                Host: host,
                Connection: "close",
                Accept: "*/*",
                ...headers,
            };
            if (body && !mergedHeaders["Content-Length"] && !mergedHeaders["content-length"]) {
                mergedHeaders["Content-Length"] = Buffer.byteLength(body);
            }
            for (const [k, v] of Object.entries(mergedHeaders)) {
                if (v === undefined || v === null) continue;
                header += `${k}: ${v}\r\n`;
            }
            header += "\r\n";
            socket.write(header);
            if (body) {
                socket.write(body);
            }
        }

        let buffer = Buffer.alloc(0);
        let headerEnd = -1;
        let statusLine = "";
        let responseHeaders = {};
        let isChunked = false;
        let done = false;

        const timer = setTimeout(() => {
            if (!done) {
                socket.destroy(new Error("上游请求超时"));
            }
        }, timeoutMs);

        socket.on("data", (c) => {
            buffer = Buffer.concat([buffer, c]);
            if (headerEnd < 0) {
                const idx = buffer.indexOf("\r\n\r\n");
                if (idx >= 0) {
                    headerEnd = idx;
                    const headerText = buffer.slice(0, idx).toString("utf-8");
                    const lines = headerText.split("\r\n");
                    statusLine = lines[0];
                    responseHeaders = {};
                    for (const line of lines.slice(1)) {
                        const ci = line.indexOf(":");
                        if (ci > 0) {
                            responseHeaders[line.slice(0, ci).trim().toLowerCase()] =
                                line.slice(ci + 1).trim();
                        }
                    }
                    // 记下 chunked 后再删逐跳头（close 阶段解 chunk 用）
                    isChunked = /chunked/i.test(responseHeaders["transfer-encoding"] ?? "");
                    delete responseHeaders["transfer-encoding"];
                    delete responseHeaders.connection;
                    delete responseHeaders["content-encoding"];
                }
            }
        });

        socket.on("close", () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (headerEnd < 0) {
                reject(new Error("上游无响应"));
                return;
            }
            let body = buffer.slice(headerEnd + 4);
            // 简单处理 chunked：Node 关闭连接时已收到完整数据，手动解 chunk
            if (body.length && isChunked) {
                body = dechunk(body);
            }
            resolve({
                statusLine,
                status: parseInt(statusLine.split(" ")[1] ?? "502", 10),
                headers: responseHeaders,
                body,
            });
        });

        socket.on("error", (e) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                reject(e);
            }
        });
    });
}

/**
 * 带重定向跟随的转发（gitee 等图床/源码站常用 302 跳 CDN）。
 * 301/302/303 改 GET 丢 body；307/308 原样重发。
 */
export function rawRequest(options, redirectsLeft = 5) {
    return singleRawRequest(options).then((res) => {
        const location = res.headers["location"];
        if (
            !location ||
            redirectsLeft <= 0 ||
            ![301, 302, 303, 307, 308].includes(res.status)
        ) {
            return res;
        }
        const base = `${options.protocol}//${options.host}${options.path}`;
        const next = new URL(location, base);
        const followGet = res.status !== 307 && res.status !== 308;
        const headers = { ...options.headers };
        delete headers.host;
        delete headers.Host;
        return rawRequest(
            {
                protocol: next.protocol,
                host: next.hostname,
                port: Number(next.port || (next.protocol === "https:" ? 443 : 80)),
                path: next.pathname + next.search,
                method: followGet ? "GET" : options.method,
                headers,
                body: followGet ? undefined : options.body,
                timeoutMs: options.timeoutMs,
            },
            redirectsLeft - 1,
        );
    });
}

function dechunk(buf) {
    const out = [];
    let offset = 0;
    while (offset < buf.length) {
        const lineEnd = buf.indexOf("\r\n", offset);
        if (lineEnd < 0) break;
        const size = parseInt(buf.slice(offset, lineEnd).toString("ascii").split(";")[0], 16);
        if (!Number.isFinite(size) || size === 0) break;
        out.push(buf.slice(lineEnd + 2, lineEnd + 2 + size));
        offset = lineEnd + 2 + size + 2;
    }
    return Buffer.concat(out);
}

function parseTargetUrl(url) {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    return {
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: Number(port),
        path: parsed.pathname + parsed.search,
    };
}

/**
 * 处理 /ping /relay /media 三个端点；其他路径调用 next() 交给后续中间件。
 * 返回 true 表示请求已被本代理处理。
 */
export async function handleProxyRoute(req, res, next) {
    let url;
    try {
        url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
        next?.();
        return false;
    }
    if (!["/ping", "/relay", "/media"].includes(url.pathname)) {
        next?.();
        return false;
    }

    setCors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return true;
    }

    try {
        if (url.pathname === "/ping") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ service: PROXY_SERVICE, ok: true }));
            return true;
        }

        if (url.pathname === "/relay" && req.method === "POST") {
            const raw = (await readBody(req)).toString("utf-8");
            const payload = JSON.parse(raw);
            const {
                url: targetUrl,
                method = "GET",
                headers = {},
                body,
                responseType = "text",
            } = payload;
            if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
                throw new Error("url 必须是 http(s) 链接");
            }
            const target = parseTargetUrl(targetUrl);
            const forwardHeaders = { ...headers };
            delete forwardHeaders.host;
            delete forwardHeaders.Host;
            const upstream = await rawRequest({
                ...target,
                method,
                headers: forwardHeaders,
                body: body ? Buffer.from(String(body), "utf-8") : undefined,
            });
            const isBase64 = responseType === "base64";
            const data = isBase64
                ? upstream.body.toString("base64")
                : upstream.body.toString("utf-8");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: upstream.status,
                    statusText: upstream.statusLine.split(" ").slice(2).join(" "),
                    headers: upstream.headers,
                    encoding: isBase64 ? "base64" : "text",
                    data,
                }),
            );
            return true;
        }

        if (url.pathname === "/media" && req.method === "GET") {
            const u = url.searchParams.get("u");
            const h = url.searchParams.get("h");
            if (!u) {
                throw new Error("缺少 u 参数");
            }
            const targetUrl = b64urlDecode(u);
            const extraHeaders = h ? JSON.parse(b64urlDecode(h)) : {};
            const target = parseTargetUrl(targetUrl);
            const forwardHeaders = { ...extraHeaders };
            // 透传 Range（流媒体拖动进度必需）
            if (req.headers.range) {
                forwardHeaders.Range = req.headers.range;
            }
            // 媒体流可能很大：直接把上游响应管道回客户端
            const upstream = await rawRequest({ ...target, method: "GET", headers: forwardHeaders });
            const outHeaders = { ...upstream.headers };
            if (!outHeaders["accept-ranges"]) {
                outHeaders["accept-ranges"] = "bytes";
            }
            res.writeHead(
                upstream.status >= 200 && upstream.status < 400 ? upstream.status : 502,
                outHeaders,
            );
            res.end(upstream.body);
            return true;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return true;
    } catch (e) {
        console.error("[proxy]", req.method, url.pathname, e?.message ?? e);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: e?.message ?? String(e) }));
        return true;
    }
}

/** Vite 插件：dev / preview 服务器同源挂载代理端点（浏览器调试零配置） */
export function createViteProxyPlugin() {
    const attach = (middlewares) => {
        middlewares.use((req, res, next) => {
            handleProxyRoute(req, res, next);
        });
    };
    return {
        name: "musicfree-hy-companion-proxy",
        configureServer(server) {
            attach(server.middlewares);
        },
        configurePreviewServer(server) {
            attach(server.middlewares);
        },
    };
}
