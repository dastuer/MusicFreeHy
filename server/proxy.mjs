/**
 * MusicFree 伴生代理（可选独立进程）
 *
 * 浏览器调试时的兜底通道：把地址填进「设置 → 网络」即可（同源内置代理不可用时才需要，
 * 例如前端产物部署在静态服务器上）。`npm run dev` / `npm run preview` 已通过
 * server/proxyCore.mjs 在同源挂载了同样的端点，无需单独起进程。
 *  - POST /relay  转发插件 API 请求（JSON：url/method/headers/body）
 *  - GET  /media?u=<b64url>&h=<b64url(json headers)>  转发媒体流（透传 Range）
 *  - GET  /ping   健康检查
 */

import http from "node:http";
import os from "node:os";
import { handleProxyRoute, PROXY_SERVICE } from "./proxyCore.mjs";

const PORT = Number(process.env.PORT || 7952);
const HOST = process.env.HOST || "0.0.0.0";

const server = http.createServer((req, res) => {
    handleProxyRoute(req, res, () => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found", service: PROXY_SERVICE }));
    });
});

// 局域网可访问的提示
server.listen(PORT, HOST, () => {
    const ifaces = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(ifaces)) {
        for (const it of list ?? []) {
            if (it.family === "IPv4" && !it.internal) {
                ips.push(it.address);
            }
        }
    }
    console.log("MusicFree 伴生代理已启动");
    console.log(`  本机:   http://localhost:${PORT}`);
    for (const ip of ips) {
        console.log(`  局域网: http://${ip}:${PORT}   <- 把这个地址填进应用设置（仅浏览器环境需要）`);
    }
});
