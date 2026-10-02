import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.huah.musicfree.hy",
    appName: "MusicFreeHy",
    webDir: "dist",
    // Android WebView 用 https scheme，媒体直链与 Cookie 行为和 iOS 一致
    server: {
        androidScheme: "https",
    },
    android: {
        // 页面固定在 https://localhost，而音源（如网易 m*.music.126.net）返回的
        // 媒体直链是 http，WebView 默认按混合内容拦截，<audio> 连请求都发不出去。
        // <audio> 又没法带 Referer/UA/Cookie，无法靠代理绕过，只能放行混合内容。
        // 仅影响 Android WebView；清单里已开 usesCleartextTraffic。
        allowMixedContent: true,
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
