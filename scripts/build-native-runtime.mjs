/**
 * 构建原生音源插件运行时 bundle（src/native/nativeRuntimeEntry.ts → IIFE 单文件），
 * 产出：
 *   dist/assets/native-plugin-runtime.js            （随 cap sync 进 WebView 可见的资产，便于调试）
 *   android/app/src/main/assets/native-plugin-runtime.js （APK 内，PluginRuntime 直接读它）
 *
 * 用法：node scripts/build-native-runtime.mjs
 * 顺序要求：必须在 `vite build` 之后跑（主构建会清空 dist）。
 */

import { build } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "native", "nativeRuntimeEntry.ts");
const distOut = path.join(root, "dist", "assets");
const androidAssets = path.join(root, "android", "app", "src", "main", "assets");
const fileName = "native-plugin-runtime.js";

if (!fs.existsSync(entry)) {
    console.error(`[build-native-runtime] 入口不存在：${entry}`);
    process.exit(1);
}

await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    build: {
        outDir: distOut,
        emptyOutDir: false,
        target: "es2020",
        minify: "esbuild",
        sourcemap: false,
        lib: {
            entry,
            formats: ["iife"],
            name: "NativePluginRuntime",
            fileName: () => fileName,
        },
        rollupOptions: {
            output: { inlineDynamicImports: true },
        },
    },
});

const built = path.join(distOut, fileName);
if (!fs.existsSync(built)) {
    console.error(`[build-native-runtime] 产物缺失：${built}`);
    process.exit(1);
}
fs.mkdirSync(androidAssets, { recursive: true });
const target = path.join(androidAssets, fileName);
fs.copyFileSync(built, target);

const size = fs.statSync(target).size;
console.log(
    `[build-native-runtime] ${fileName} → ${path.relative(root, target)} (${(size / 1024).toFixed(1)} KB)`,
);
