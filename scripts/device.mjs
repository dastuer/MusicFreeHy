/**
 * 编译 + 局域网调试快捷脚本（Windows / macOS 通用）
 *
 * 用法：
 *   npm run android:connect            # 连接局域网设备（mDNS 自动发现，或 --host ip:port 指定）
 *   npm run android:run                # 编译 Web + 同步 + Gradle 打包 + 安装启动 + 开调试端口
 *   npm run android:run -- --release   # 打正式签名包安装（手机上已装正式包时用它覆盖，数据保留）
 *   npm run android:run -- --no-build  # 跳过 Web 构建（只重打原生包）
 *   npm run android:live               # 局域网热重载调试：手机加载电脑上的 vite 开发服务器，
 *                                      # 改 src 下代码手机即时生效，无需重新打包
 *   npm run android:log                # 查看设备上的应用日志（Capacitor/Console）
 *
 * 环境默认值可用环境变量覆盖：DEVICE_JAVA_HOME / ANDROID_HOME / VITE_PORT / DEVICE_HOST。
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ANDROID_DIR = path.join(ROOT, "android");
const PATCHED_CONFIG = path.join(
    ANDROID_DIR,
    "app/src/main/assets/capacitor.config.json",
);

const IS_WIN = process.platform === "win32";

/** macOS 用系统的 java_home 命令定位 JDK（没有就空着，gradlew 会退回 PATH 里的 java） */
function macJavaHome() {
    try {
        return execFileSync("/usr/libexec/java_home", []).toString().trim();
    } catch {
        return "";
    }
}

const DEFAULT_SDK = IS_WIN
    ? "D:\\Android\\Sdk"
    : path.join(os.homedir(), "Library", "Android", "sdk");

const ENV = {
    // 注意：默认值优先于继承的 JAVA_HOME —— Windows 全局 JAVA_HOME 常指向老 JDK，
    // 会让 AGP 8.13 的构建脚本解析失败；确需覆盖时设置 DEVICE_JAVA_HOME
    JAVA_HOME: process.env.DEVICE_JAVA_HOME || (IS_WIN ? "D:\\Android\\jdk-21.0.12.1+1" : macJavaHome()),
    ANDROID_HOME: process.env.ANDROID_HOME || DEFAULT_SDK,
    // 与 vite.config.ts 的 server.port 保持一致；strictPort 下端口被占会直接报错
    VITE_PORT: process.env.VITE_PORT || "5175",
};
const ADB = path.join(
    ENV.ANDROID_HOME,
    "platform-tools",
    IS_WIN ? "adb.exe" : "adb",
);
const APP_ID = fs
    .readFileSync(path.join(ANDROID_DIR, "app/build.gradle"), "utf8")
    .match(/applicationId\s+"([^"]+)"/)?.[1];

function die(msg) {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

function run(cmd, args, opts = {}) {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: "inherit",
            ...opts,
        });
        child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`)),
        );
        child.on("error", reject);
    });
}

/** Windows 下 npm/npx/gradlew 是 .cmd/.bat，需经 cmd /c 调起 */
function nativeCmd(cmd, args, opts = {}) {
    if (process.platform === "win32") {
        return run("cmd", ["/c", cmd, ...args], opts);
    }
    return run(cmd, args, opts);
}

/** 带继承环境 + 默认 JDK/SDK 的子进程环境 */
function envForGradle() {
    return {
        ...process.env,
        JAVA_HOME: ENV.JAVA_HOME,
        ANDROID_HOME: ENV.ANDROID_HOME,
    };
}

function adb(args, { quiet = false } = {}) {
    const out = execFileSync(ADB, args, {
        encoding: "utf8",
        stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "inherit"],
    });
    return out;
}

/** 当前已授权连接的设备序列号；无设备返回 null */
function connectedDevice() {
    try {
        const out = adb(["devices"], { quiet: true });
        const rows = out
            .split("\n")
            .slice(1)
            .map((l) => l.trim())
            .filter(Boolean);
        const ready = rows.filter((l) => /\tdevice$/.test(l));
        if (ready.length) {
            return ready[0].split("\t")[0];
        }
        if (rows.some((l) => /unauthorized|offline/.test(l))) {
            console.warn("! 设备已连接但未授权/离线，请在手机上确认授权弹窗");
        }
    } catch {
        // adb 不可用
    }
    return null;
}

/** 连接局域网设备：优先 mDNS 自动发现 _adb-tls-connect，失败则提示手动指定 */
async function ensureDevice(hostArg) {
    let serial = connectedDevice();
    if (serial) {
        return serial;
    }
    if (hostArg) {
        adb(["connect", hostArg]);
        serial = connectedDevice();
        if (serial) {
            return serial;
        }
        die(`无法连接 ${hostArg}，确认手机与电脑同一网络、无线调试已开启`);
    }
    // 自动发现：adb mdns services 输出里带 _adb-tls-connect._tcp 的 ip:port
    let addr = null;
    try {
        const out = adb(["mdns", "services"], { quiet: true });
        addr = out.match(/(\d+\.\d+\.\d+\.\d+:\d+)/)?.[1];
    } catch {
        // 老版本 adb 不支持 mdns
    }
    if (addr) {
        console.log(`发现局域网设备 ${addr}，正在连接…`);
        adb(["connect", addr]);
        serial = connectedDevice();
        if (serial) {
            return serial;
        }
    }
    die(
        "未发现设备。手机开启「开发者选项 → 无线调试」，" +
            "用其页面显示的 IP:端口 执行：npm run android:connect -- --host 192.168.x.x:port",
    );
}

/** Gradle 打包：--release 走正式签名（与手机上已装的包同签名可覆盖），默认 debug */
async function buildApk(release) {
    const task = release ? "assembleRelease" : "assembleDebug";
    if (IS_WIN) {
        const gradlew = path.join(ANDROID_DIR, "gradlew.bat");
        await run("cmd", ["/c", gradlew, task, "--console=plain"], {
            cwd: ANDROID_DIR,
            env: envForGradle(),
        });
        return;
    }
    const gradlew = path.join(ANDROID_DIR, "gradlew");
    await run(gradlew, [task, "--console=plain"], {
        cwd: ANDROID_DIR,
        env: envForGradle(),
    });
}

const apkPath = (release) =>
    path.join(
        ANDROID_DIR,
        "app/build/outputs/apk",
        release ? "release/app-release.apk" : "debug/app-debug.apk",
    );

async function install(serial, release) {
    await run(ADB, ["-s", serial, "install", "-r", apkPath(release)]);
}

async function launch(serial) {
    adb(["-s", serial, "shell", "am", "start", "-n", `${APP_ID}/.MainActivity`]);
}

/** 应用 pid；未运行返回空串（pidof 找不到进程时以非零码退出） */
function appPid(serial) {
    try {
        return adb(["-s", serial, "shell", "pidof", APP_ID], { quiet: true }).trim();
    } catch {
        return "";
    }
}

/** 等待 WebView 调试 socket 就绪并转发 tcp:9222，供 chrome://inspect */
async function forwardDevtools(serial) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const pid = appPid(serial);
        if (pid) {
            const sockets = adb(["-s", serial, "shell", "cat", "/proc/net/unix"], {
                quiet: true,
            });
            const name = sockets
                .split("\n")
                .find((l) => l.includes(`webview_devtools_remote_${pid}`))
                ?.trim()
                .split(/\s+/)
                .pop();
            if (name) {
                const abstract = name.replace(/^@/, "");
                adb(["-s", serial, "forward", "tcp:9222", `localabstract:${abstract}`]);
                return true;
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

function printDebugHint(serial) {
    console.log(`
────────────────────────────────────────────
✓ 已安装并启动，调试通道已就绪（设备 ${serial}）
  · Chrome 打开 chrome://inspect → 选中页面 Inspect
  · 或浏览器访问 http://localhost:9222 查看可检查目标
  · 日志：npm run android:log
────────────────────────────────────────────`);
}

/** Web 构建（tsc + vite）+ cap sync */
async function buildAndSync(skipBuild = false) {
    if (!skipBuild) {
        await nativeCmd("npm", ["run", "build"], { cwd: ROOT });
    }
    await nativeCmd("npx", ["cap", "sync", "android"], { cwd: ROOT });
}

/** 命令：run —— 完整编译安装 */
async function cmdRun({ noBuild, release }) {
    await buildAndSync(noBuild);
    const serial = await ensureDevice(process.env.DEVICE_HOST);
    await buildApk(release);
    await install(serial, release);
    await launch(serial);
    await forwardDevtools(serial);
    printDebugHint(serial);
}

/** 命令：connect —— 仅连接设备 */
async function cmdConnect() {
    const serial = await ensureDevice(process.env.DEVICE_HOST);
    console.log(`✓ 设备已连接：${serial}`);
}

/** 命令：log —— 应用日志 */
async function cmdLog() {
    const serial = await ensureDevice(process.env.DEVICE_HOST);
    const pid = appPid(serial);
    if (!pid) {
        die("应用未在运行，先 npm run android:run");
    }
    await run(ADB, [
        "-s",
        serial,
        "logcat",
        `--pid=${pid}`,
        "Capacitor:V",
        "Capacitor/Console:V",
        "chromium:V",
        "*:S",
    ]);
}

/** 电脑局域网 IPv4（供手机访问 vite 开发服务器） */
function lanIp() {
    const all = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => i.address);
    return (
        all.find((ip) => ip.startsWith("192.168.")) ??
        all.find((ip) => ip.startsWith("10.")) ??
        all[0]
    );
}

/** 等待 vite 就绪，返回实际端口（横幅带 ANSI 颜色码，匹配前先剥离） */
async function waitForVite(child, preferred) {
    const deadline = Date.now() + 30000;
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.stderr.on("data", (d) => (buf += d.toString()));
    while (Date.now() < deadline) {
        const plain = buf.replace(/\x1b\[[0-9;]*m/g, "");
        const port =
            plain.match(/Local:\s+http:\/\/[^\s:]+:(\d+)/)?.[1] ??
            plain.match(/Network:\s+http:\/\/[^\s:]+:(\d+)/)?.[1];
        if (port) {
            const reachable = await new Promise((res) =>
                http.get(`http://127.0.0.1:${port}`, (r) => {
                    r.resume();
                    res(r.statusCode < 500);
                }).on("error", () => res(false)),
            );
            if (reachable) {
                return Number(port);
            }
        }
        if (child.exitCode !== null) {
            throw new Error(`vite 启动失败：${plain.trim().slice(-400) || "无输出"}`);
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`vite 30s 内未就绪（预期端口 ${preferred}）\n输出：${buf.slice(-400)}`);
}

/** 命令：live —— 局域网热重载调试 */
async function cmdLive() {
    const serial = await ensureDevice(process.env.DEVICE_HOST);
    const ip = lanIp();
    if (!ip) {
        die("未找到电脑的局域网 IP，无法热重载");
    }
    const originalConfig = fs.existsSync(PATCHED_CONFIG)
        ? fs.readFileSync(PATCHED_CONFIG, "utf8")
        : null;
    let vite;
    const cleanup = () => {
        // 还原打包配置，避免下次 run 打出指向开发服务器的包
        if (originalConfig !== null) {
            try {
                fs.writeFileSync(PATCHED_CONFIG, originalConfig);
            } catch {
                // 下次 cap sync 也会重新生成
            }
        }
        try {
            adb(["-s", serial, "forward", "--remove", "tcp:9222"]);
        } catch {
            // ignore
        }
        if (vite?.pid) {
            // shell:true 包了一层 cmd，必须整棵进程树杀掉，否则 vite 残留占着端口
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
                vite.kill();
            }
        }
    };
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGBREAK", () => {
        cleanup();
        process.exit(0);
    });

    console.log(`$ npx vite --host --port ${ENV.VITE_PORT}`);
    vite = spawn("npx", ["vite", "--host", "--port", ENV.VITE_PORT], {
        cwd: ROOT,
        shell: true,
    });
    try {
        const port = await waitForVite(vite, ENV.VITE_PORT);
        console.log(`✓ vite 就绪：http://${ip}:${port}`);

        // live 模式不需要 Web 产物，但插件清单等仍要同步一次
        await nativeCmd("npx", ["cap", "sync", "android"], { cwd: ROOT });

        // 把 WebView 指向开发服务器（http 明文已由 AndroidManifest usesCleartextTraffic 允许）
        const cfg = JSON.parse(fs.readFileSync(PATCHED_CONFIG, "utf8"));
        cfg.server = { ...cfg.server, url: `http://${ip}:${port}`, cleartext: true };
        fs.writeFileSync(PATCHED_CONFIG, JSON.stringify(cfg, null, 4));

        await buildApk();
        await install(serial);
        await launch(serial);
        await forwardDevtools(serial);
    } catch (e) {
        // 任何一步失败都要清掉 vite，否则孤儿进程会一直占着端口
        cleanup();
        die(e.message);
    }

    console.log(`
────────────────────────────────────────────
✓ 热重载调试中：手机加载电脑上的开发服务器
  · 修改 src/ 下代码，手机上即时生效（无需重新打包）
  · 原生代码/插件变更需 Ctrl+C 后重新 npm run android:live
  · Chrome: chrome://inspect 或 http://localhost:9222
  · Ctrl+C 退出并还原打包配置
────────────────────────────────────────────`);
    // 保持进程存活，承载 vite
    vite.on("exit", () => {
        console.log("vite 已退出");
        cleanup();
        process.exit(0);
    });
}

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));
const options = { noBuild: flags.has("--no-build"), release: flags.has("--release") };

const commands = {
    connect: cmdConnect,
    run: () => cmdRun(options),
    live: cmdLive,
    log: cmdLog,
};

if (!APP_ID) {
    die("未能从 android/app/build.gradle 解析 applicationId");
}
if (!commands[cmd]) {
    die(`未知命令 "${cmd}"，可用：${Object.keys(commands).join(" / ")}（见 scripts/device.mjs 头部说明）`);
}
commands[cmd]().catch((e) => die(e.message));
