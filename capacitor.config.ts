import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.huah.musicfree.hy",
    appName: "MusicFree",
    webDir: "dist",
    // Android WebView 用 https scheme，媒体直链与 Cookie 行为和 iOS 一致
    server: {
        androidScheme: "https",
    },
    plugins: {
        // 原生环境接管主线程 fetch/XHR：无跨域限制、支持自定义请求头
        // （Worker 里的插件请求另有「宿主中继」通道，见 core/pluginHost.ts）
        CapacitorHttp: {
            enabled: true,
        },
        // Android 15+ 强制 edge-to-edge：系统栏透明、WebView 沉浸绘制到底，
        // 栏区显示的就是页面/播放器自身的背景；DARK = 深色底浅色图标
        SystemBars: {
            style: "DARK",
            initialViewportFitValueHint: "cover",
        },
    },
};

export default config;
