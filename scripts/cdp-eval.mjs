#!/usr/bin/env node
/**
 * CDP 调试工具：向模拟器 WebView 注入 JS / 截图。
 * 用法:
 *   node scripts/cdp-eval.mjs '<js expression>'        # Runtime.evaluate (支持 await)
 *   node scripts/cdp-eval.mjs --screenshot out.png     # 截图
 *   node scripts/cdp-eval.mjs --reload                 # 重载页面
 *   node scripts/cdp-eval.mjs --freeze                 # 冻结页面（模拟 ROM 后台冻结 JS）
 *   node scripts/cdp-eval.mjs --thaw                   # 恢复
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const listRes = await fetch("http://localhost:9222/json");
const targets = await listRes.json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no MusicFreeHy page target");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res) => {
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    console.error("EXC:", JSON.stringify(r.result.exceptionDetails, null, 2));
    process.exitCode = 2;
  }
  return r.result?.result?.value ?? r.result;
}

if (args[0] === "--screenshot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(args[1] ?? "/tmp/cdp-shot.png", Buffer.from(r.result.data, "base64"));
  console.log("saved", args[1] ?? "/tmp/cdp-shot.png");
} else if (args[0] === "--reload") {
  await send("Page.reload", { ignoreCache: false });
  console.log("reloaded");
} else if (args[0] === "--freeze" || args[0] === "--thaw") {
  await send("Page.setWebLifecycleState", {
    state: args[0] === "--freeze" ? "frozen" : "active",
  });
  console.log(args[0] === "--freeze" ? "frozen" : "active");
} else {
  const expr = args.join(" ");
  const v = await evalJs(expr);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
ws.close();
