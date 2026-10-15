/**
 * 原生音源插件运行时冒烟测试（不连真机）
 *
 * 用 quickjs-emscripten（同一套 QuickJS 语义的 WASM 版）跑真实产物
 * android/app/src/main/assets/native-plugin-runtime.js，复刻 Java PluginRuntime 的
 * 调用契约：注入 __nativeHttp 宿主函数 → evaluate bundle → __sync 挂插件 →
 * __start 启动任务 → 轮询 __jobState / __tick → 取 __jobResult。
 *
 * 覆盖：同步 HTTP 适配器（URL 拼参/请求头/JSON 体）、音质降档、excludeUrl 跳过、
 * 定时器补丁（QuickJS 无事件循环）、缺插件平台的失败路径、call 方法序列化。
 *
 * 用法：node scripts/test-native-runtime.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "android/app/src/main/assets/native-plugin-runtime.js");

if (!existsSync(bundlePath)) {
    console.error(`[test] 产物不存在，先跑 npm run build:runtime → ${bundlePath}`);
    process.exit(1);
}

const { getQuickJS } = await import("quickjs-emscripten");

let failures = 0;
function assert(cond, label, detail) {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        failures += 1;
        console.error(`  ✗ ${label}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`);
    }
}

const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
const context = runtime.newContext();

function dispose(v) {
    if (v && typeof v.dispose === "function") {
        try {
            v.dispose();
        } catch {
            /* ignore */
        }
    }
}

function evalJs(code, filename = "test.js") {
    const res = context.evalCode(code, filename);
    if (res.error) {
        const err = context.dump(res.error);
        dispose(res.error);
        throw new Error(`JS 异常（${filename}）: ${JSON.stringify(err)}`);
    }
    const out = context.dump(res.value);
    dispose(res.value);
    return out;
}

/** 与 Java PluginRuntime.ensureReady 等价的注入步骤 */
const consoleFn = context.newFunction("__hostLog", (levelH, msgH) => {
    console.log(`    [js:${context.dump(levelH)}] ${context.dump(msgH)}`);
    return context.undefined;
});
const consoleObj = context.newObject();
for (const level of ["log", "info", "warn", "error"]) {
    const fn = context.newFunction(`console_${level}`, (msgH) => {
        console.log(`    [js:${level}] ${context.dump(msgH)}`);
        return context.undefined;
    });
    context.setProp(consoleObj, level, fn);
    dispose(fn);
}
context.setProp(consoleObj, "stdout", consoleFn);
context.setProp(context.global, "console", consoleObj);
dispose(consoleObj);
dispose(consoleFn);

/** 宿主 HTTP 桩：记录请求，按 URL 回不同响应（含一条模拟网络错误） */
const httpCalls = [];
const httpFn = context.newFunction("__nativeHttp", (urlH, methodH, headersH, bodyH) => {
    const call = {
        url: context.dump(urlH),
        method: context.dump(methodH),
        headers: JSON.parse(context.dump(headersH) || "{}"),
        body: bodyH && context.dump(bodyH) !== null ? context.dump(bodyH) : null,
    };
    httpCalls.push(call);
    let out;
    if (call.url.startsWith("https://api.l4a.test/")) {
        out = {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ url: "https://cdn.l4a.test/a.mp3" }),
        };
    } else if (call.url.startsWith("https://boom.l4a.test/")) {
        out = { error: "connect timeout" };
    } else {
        out = { status: 404, headers: {}, text: "not found" };
    }
    return context.newString(JSON.stringify(out));
});
context.setProp(context.global, "__nativeHttp", httpFn);
dispose(httpFn);

// 1) 加载 bundle（等价 Java 的 ctx.evaluate(bundle)）
const bundle = readFileSync(bundlePath, "utf8");
console.log(`[test] bundle ${(bundle.length / 1024).toFixed(1)} KB`);
evalJs(bundle, "native-plugin-runtime.js");
runtime.executePendingJobs();

// 2) 挂插件（等价 fSync.call(persistedJson)）
const pluginA = `
const axios = require("axios");
module.exports = {
    platform: "L4A",
    version: "1.0.0",
    async getMediaSource(musicItem, quality) {
        const res = await axios.get("https://api.l4a.test/song", {
            params: { id: musicItem.id, quality },
            headers: { "User-Agent": "L4A/1.0", Referer: "https://l4a.test/" },
        });
        return {
            url: res.data.url,
            headers: { Referer: "https://l4a.test/" },
            userAgent: "L4A/1.0",
            quality,
        };
    },
    async search(query) {
        return { data: [{ id: "1", title: String(query) }] };
    },
};
`;

const pluginB = `
module.exports = {
    platform: "L4B",
    version: "1.0.0",
    async getMediaSource(musicItem, quality) {
        if (quality === "high" || quality === "super") {
            return null;                 // 只承认 standard/low，逼出降档链
        }
        await new Promise((r) => setTimeout(r, 30));   // 依赖原生定时器补丁 + __tick
        return { url: "https://cdn.l4b.test/" + quality + ".mp3" };
    },
    async search() {
        return { data: [] };
    },
};
`;

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const pluginsJson = JSON.stringify([
    { hash: sha256(pluginA), code: pluginA, userVariables: {} },
    { hash: sha256(pluginB), code: pluginB, userVariables: {} },
]);

const syncRes = evalJs(`__sync(${JSON.stringify(pluginsJson)})`);
runtime.executePendingJobs();
console.log(`[test] __sync → ${syncRes}`);
assert(syncRes.includes('"ok":true'), "__sync 成功", syncRes);
assert(syncRes.includes('"total":2'), "挂载 2 个插件", syncRes);

const health = evalJs("__health()");
assert(health.includes("L4A") && health.includes("L4B"), "__health 列出插件", health);

/** 复刻 Java doResolve 的轮询 */
function runTask(kind, a, b, c, { timeoutMs = 8000 } = {}) {
    evalJs(`__start(${JSON.stringify(kind)}, ${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)})`);
    runtime.executePendingJobs();
    const deadline = Date.now() + timeoutMs;
    let state = evalJs("__jobState()");
    while (state === "pending") {
        if (Date.now() > deadline) {
            throw new Error("任务超时");
        }
        evalJs("__tick()");
        runtime.executePendingJobs();
        state = evalJs("__jobState()");
    }
    if (state !== "fulfilled") {
        throw new Error(`任务失败：${evalJs("__jobError()")}`);
    }
    return JSON.parse(evalJs("__jobResult()"));
}

// 3) 解析 A：同步 HTTP + 参数/请求头透传
console.log("[test] resolve L4A（axios → 原生 HTTP）");
const r1 = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "L4A", id: "1", title: "t" }, quality: "standard" }),
    "",
    "",
);
assert(r1.ok === true, "A 解析成功", r1);
assert(r1.url === "https://cdn.l4a.test/a.mp3", "A 直链正确", r1.url);
assert(r1.userAgent === "L4A/1.0", "A userAgent 回传", r1.userAgent);
const call1 = httpCalls.find((c) => c.url.includes("api.l4a.test"));
assert(!!call1, "宿主 HTTP 被调用", httpCalls);
assert(
    call1 && call1.url === "https://api.l4a.test/song?id=1&quality=standard",
    "GET 参数拼进 URL",
    call1 && call1.url,
);
assert(call1 && call1.method === "GET", "请求方法 GET", call1 && call1.method);
assert(
    call1 && call1.headers["User-Agent"] === "L4A/1.0" && call1.headers["Referer"] === "https://l4a.test/",
    "插件自定义请求头原样到达宿主",
    call1 && call1.headers,
);

// 4) 解析 B：音质降档 + 定时器 + excludeUrl 跳过
console.log("[test] resolve L4B（降档 + 定时器 + excludeUrl）");
const r2 = runTask(
    "resolve",
    JSON.stringify({
        item: { platform: "L4B", id: "9" },
        quality: "high",
        excludeUrl: "https://cdn.l4b.test/standard.mp3",
    }),
    "",
    "",
);
assert(r2.ok === true, "B 解析成功", r2);
assert(r2.url === "https://cdn.l4b.test/low.mp3", "high→standard(被 exclude)→low", r2.url);

const r2b = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "L4B", id: "9" }, quality: "high" }),
    "",
    "",
);
assert(r2b.url === "https://cdn.l4b.test/standard.mp3", "无 excludeUrl 时落 standard", r2b.url);

// 5) 缺插件平台
const r3 = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "不存在的平台", id: "1" }, quality: "standard" }),
    "",
    "",
);
assert(r3.ok === false, "缺插件返回 ok:false", r3);
assert(String(r3.reason).includes("未找到平台"), "失败原因可读", r3.reason);

// 6) call 方法：序列化 + 补丁
console.log("[test] call（search 序列化）");
const hashA = sha256(pluginA);
const r4 = runTask("call", hashA, "search", JSON.stringify(["关键词"]));
assert(r4 && r4.data && r4.data[0].title === "关键词", "call 返回序列化结果", r4);

// 7) 宿主错误透传（插件请求一个桩不认的地址 → 404）
console.log("[test] HTTP 错误路径");
const pluginC = `
const axios = require("axios");
module.exports = {
    platform: "L4C",
    version: "1.0.0",
    async getMediaSource() {
        await axios.get("https://boom.l4a.test/x");   // 桩返回 {"error":...}
        return { url: "https://never.test/" };
    },
};
`;
const sync2 = evalJs(`__sync(${JSON.stringify(
    JSON.stringify([
        { hash: sha256(pluginA), code: pluginA, userVariables: {} },
        { hash: sha256(pluginB), code: pluginB, userVariables: {} },
        { hash: sha256(pluginC), code: pluginC, userVariables: {} },
    ]),
)})`);
runtime.executePendingJobs();
assert(sync2.includes('"total":3'), "增量同步第 3 个插件", sync2);
const r5 = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "L4C", id: "1" }, quality: "standard" }),
    "",
    "",
);
assert(r5.ok === false, "宿主网络错误被插件捕获后返回 ok:false", r5);
assert(String(r5.reason).includes("原生网络错误"), "错误信息透传到 reason", r5.reason);

// 8) fetch 插件（不打 axios，直接用全局 fetch）+ TextDecoder
console.log("[test] fetch 插件 + TextDecoder");
const pluginD = `
module.exports = {
    platform: "L4D",
    version: "1.0.0",
    async getMediaSource(musicItem, quality) {
        // 直接用 fetch（此前原生侧是硬拒绝，这类插件后台必然解析失败）
        const res = await fetch("https://api.l4a.test/fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-From": "fetch" },
            body: JSON.stringify({ id: musicItem.id, quality }),
        });
        if (!res.ok) {
            return null;
        }
        const data = await res.json();
        // TextDecoder 也必须在（QuickJS 原生没有）
        const decoded = new TextDecoder("utf-8").decode(
            new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]),
        );
        return { url: data.url + "?decoded=" + decoded, quality };
    },
};
`;
const listD = JSON.stringify([
    { hash: sha256(pluginB), code: pluginB, userVariables: {} },
    { hash: sha256(pluginD), code: pluginD, userVariables: {} },
]);
const syncFetch = evalJs(`__sync(${JSON.stringify(listD)})`);
runtime.executePendingJobs();
assert(syncFetch.includes('"total":2'), "同步 fetch 插件", syncFetch);
const r6 = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "L4D", id: "77" }, quality: "standard" }),
    "",
    "",
);
assert(r6.ok === true, "fetch 插件解析成功", r6);
assert(String(r6.url).includes("decoded=中文"), "TextDecoder 正确解出中文", r6.url);
const fetchCall = httpCalls.find((c) => c.url.includes("api.l4a.test/fetch"));
assert(!!fetchCall, "fetch 到达原生宿主", httpCalls.map((c) => c.url));
assert(fetchCall && fetchCall.method === "POST", "fetch 方法透传", fetchCall && fetchCall.method);
assert(
    fetchCall && fetchCall.headers["X-From"] === "fetch",
    "fetch 自定义请求头透传",
    fetchCall && fetchCall.headers,
);
assert(
    fetchCall && String(fetchCall.body).includes('"id":"77"'),
    "fetch body 透传",
    fetchCall && fetchCall.body,
);

// 9) fetch 非 2xx（res.ok === false 分支）
console.log("[test] fetch 非 2xx");
const pluginE = `
module.exports = {
    platform: "L4E",
    version: "1.0.0",
    async getMediaSource() {
        const res = await fetch("https://unknown.test/nope");
        if (res.ok) {
            return { url: "https://should-not.test/" };
        }
        return null;
    },
};
`;
const listE = JSON.stringify([
    { hash: sha256(pluginB), code: pluginB, userVariables: {} },
    { hash: sha256(pluginE), code: pluginE, userVariables: {} },
]);
evalJs(`__sync(${JSON.stringify(listE)})`);
runtime.executePendingJobs();
const r7 = runTask(
    "resolve",
    JSON.stringify({ item: { platform: "L4E", id: "1" }, quality: "standard" }),
    "",
    "",
);
assert(r7.ok === false, "fetch 非 2xx 时 res.ok=false 可判", r7);

// 10) 卸载同步（只留 B）
const listB = JSON.stringify([
    { hash: sha256(pluginB), code: pluginB, userVariables: {} },
]);
const sync3 = evalJs(`__sync(${JSON.stringify(listB)})`);
runtime.executePendingJobs();
assert(sync3.includes('"total":1'), "同步移除多余插件", sync3);

context.dispose();
runtime.dispose();

if (failures) {
    console.error(`\n[test] 失败 ${failures} 项`);
    process.exit(1);
}
console.log("\n[test] 全部通过");
