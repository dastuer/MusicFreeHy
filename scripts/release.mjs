#!/usr/bin/env node
/**
 * 一键发版：改版本号 → 出正式签名包 → Gitee 建发行版并上传 APK 附件 → 更新 update.json → 提交推送
 *
 * 用法：
 *   export GITEE_TOKEN=<私人令牌（勾 projects 权限）>
 *   node scripts/release.mjs 1.0.1                        # 更新说明自动取最近 10 条提交
 *   node scripts/release.mjs 1.1.0 --notes "- 新增xx\n- 修复yy"
 *
 * 前置：已关联名为 gitee 的 remote（git@gitee.com:<user>/<repo>.git，main 分支）。
 * 发版后清单经 Gitee raw 缓存（60~300s）生效，旧包启动 4s 后收到更新提示。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GRADLE_PATH = path.join(ROOT, "android/app/build.gradle");
const PKG_PATH = path.join(ROOT, "package.json");
const BACKUP_PATH = path.join(ROOT, "src/core/backup.ts");
const MANIFEST_PATH = path.join(ROOT, "update.json");

const log = (msg) => console.log(`[release] ${msg}`);
const die = (msg) => {
    console.error(`[release] ✗ ${msg}`);
    process.exit(1);
};

/* ---------- 参数 ---------- */

const args = process.argv.slice(2);
const ver = args[0];
if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
    die("用法：node scripts/release.mjs <版本号> [--notes \"- 更新说明\"]，版本号形如 1.0.1");
}
const notesIdx = args.indexOf("--notes");
let notes =
    notesIdx >= 0 && args[notesIdx + 1]
        ? args[notesIdx + 1].replace(/\\n/g, "\n")
        : execFileSync("git", ["log", "--pretty=format:- %s", "-10"], { cwd: ROOT }).toString();

const token = process.env.GITEE_TOKEN;
if (!token) {
    die("缺少 GITEE_TOKEN 环境变量（Gitee 私人令牌，权限勾 projects）");
}

/* ---------- Gitee remote 解析 ---------- */

const giteeUrl = execFileSync("git", ["remote", "get-url", "gitee"], { cwd: ROOT })
    .toString()
    .trim();
const ownerRepo = giteeUrl.match(/gitee\.com[:/](.+?)(?:\.git)?$/)?.[1];
if (!ownerRepo) {
    die(`无法从 gitee remote 解析仓库：${giteeUrl}`);
}

/* ---------- 1. 版本号三处联动（幂等：中断重跑时已是目标版本则跳过） ---------- */

const gradle = fs.readFileSync(GRADLE_PATH, "utf8");
const currentCode = Number(gradle.match(/versionCode (\d+)/)?.[1]);
const currentVerName = gradle.match(/versionName "([^"]*)"/)?.[1];
if (!currentCode || !currentVerName) {
    die("build.gradle 里找不到 versionCode / versionName");
}
const nextCode = currentVerName === ver ? currentCode : currentCode + 1;
if (currentVerName !== ver) {
    fs.writeFileSync(
        GRADLE_PATH,
        gradle
            .replace(/versionCode \d+/, `versionCode ${nextCode}`)
            .replace(/versionName "[^"]*"/, `versionName "${ver}"`),
    );

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    pkg.version = ver;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

    const backup = fs.readFileSync(BACKUP_PATH, "utf8");
    if (!/export const APP_VERSION = "[^"]*";/.test(backup)) {
        die("backup.ts 里找不到 APP_VERSION");
    }
    fs.writeFileSync(
        BACKUP_PATH,
        backup.replace(
            /export const APP_VERSION = "[^"]*";/,
            `export const APP_VERSION = "${ver}";`,
        ),
    );
}
log(`版本号 → versionCode ${nextCode} / versionName ${ver}（gradle、package.json、APP_VERSION）`);

/* ---------- 2. 构建前端 + 同步 WebView 资源 + 出正式签名包 ---------- */

log("构建前端（tsc + vite build）…");
execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
log("同步 WebView 资源（cap copy android）…");
execFileSync("npx", ["cap", "copy", "android"], { cwd: ROOT, stdio: "inherit" });

const gradlew = path.join(ROOT, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
const env = { ...process.env };
if (process.platform === "darwin") {
    try {
        env.JAVA_HOME = execFileSync("/usr/libexec/java_home", []).toString().trim();
    } catch {
        // 没 java_home 就退回继承的 JAVA_HOME / PATH
    }
}
log("开始 assembleRelease（几分钟，输出在 android/ 目录）…");
const build = spawnSync(gradlew, ["assembleRelease"], {
    cwd: path.join(ROOT, "android"),
    stdio: "inherit",
    env,
});
if (build.status !== 0) {
    die("gradle 出包失败");
}
const apkSrc = path.join(ROOT, "android/app/build/outputs/apk/release/app-release.apk");
if (!fs.existsSync(apkSrc)) {
    die(`找不到产物：${apkSrc}`);
}
const apkName = `MusicFreeHy-${ver}.apk`;
const apkPath = path.join(os.tmpdir(), apkName);
fs.copyFileSync(apkSrc, apkPath);
log(`签名包已产出：${apkName}（${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB）`);

/* ---------- 3. Gitee 建发行版 + 上传附件 ---------- */

async function giteeApi(pathname, options = {}) {
    const url = new URL(`https://gitee.com/api/v5${pathname}`);
    url.searchParams.set("access_token", token);
    const res = await fetch(url, options);
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Gitee API ${res.status}：${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
}

let release;
try {
    release = await giteeApi(`/repos/${ownerRepo}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            tag_name: `v${ver}`,
            name: `v${ver}`,
            body: notes,
            target_commitish: "main",
        }),
    });
} catch (e) {
    die(`创建发行版失败（tag v${ver} 可能已存在）：${e.message}`);
}
log(`发行版已创建：v${ver}（id ${release.id}）`);

let uploaded;
try {
    const form = new FormData();
    form.append(
        "file",
        new Blob([fs.readFileSync(apkPath)], {
            type: "application/vnd.android.package-archive",
        }),
        apkName,
    );
    uploaded = await giteeApi(`/repos/${ownerRepo}/releases/${release.id}/attach_files`, {
        method: "POST",
        body: form,
    });
} catch (e) {
    die(`上传 APK 附件失败：${e.message}`);
}
const apkUrl = uploaded.browser_download_url;
log(`附件已上传：${apkUrl}`);

/* ---------- 4. 更新清单 update.json ---------- */

const manifest = {
    versionCode: nextCode,
    versionName: ver,
    changelog: notes,
    apkUrl,
    publishedAt: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

/* ---------- 5. 提交并推送 ---------- */

execFileSync(
    "git",
    ["add", "android/app/build.gradle", "package.json", "src/core/backup.ts", "update.json"],
    { cwd: ROOT },
);
// 中断重跑时清单/版本号可能已无变化：无 diff 就跳过提交，推送照常
const committed = spawnSync(
    "git",
    ["commit", "-m", `发版 v${ver}（versionCode ${nextCode}）`],
    { cwd: ROOT },
);
if (committed.status === 0) {
    log("已提交版本号与清单变更");
} else {
    log("版本号与清单无变化，跳过提交");
}
execFileSync("git", ["push", "gitee", "main"], { cwd: ROOT });
log("已推送到 gitee main");

console.log(`
[release] ✓ v${ver} 发版完成
  清单：https://gitee.com/${ownerRepo}/raw/main/update.json（Gitee 缓存 60~300s 后全网生效）
  旧包启动 4s 后收到更新提示，或设置 → 关于 → 检查更新`);
