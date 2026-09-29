# MusicFree 手机版（MusicFreeHy）

运行在 **Android / iPhone** 上的音乐播放器。核心功能与 [MusicFreeDesktop](../MusicFreeDesktop) 对齐，界面参考网易云音乐手机版，**插件、歌单、备份与桌面端完全互通**。

基于 Capacitor 混合架构（Web 核心 + 原生壳），一码双端：

| 能力 | 实现方式 |
|---|---|
| 音源插件 | 与 MusicFree/MusicFreeDesktop 同一套 CommonJS 插件，Web Worker 沙箱运行 |
| 原生网络 | CapacitorHttp 接管 fetch（无跨域限制、可带 Referer/UA），Worker 请求经宿主中继 |
| 备份互通 | `musicfree-desktop` v1 格式，本地文件 / WebDAV 均与桌面端互认 |
| 数据契约 | 歌曲唯一键 `platform-id`、歌单结构 `userSheets`、「我喜欢的音乐」id `my-likes` |

## 功能

- **发现页**（网易云风格）：快捷入口、功能大卡、最近在听、推荐歌单（标签 + 网格）、排行榜
- **我的**：我喜欢的音乐、自建歌单（新建/重命名/删除）、播放历史、音源选择
- **播放页**：黑胶唱片 + 唱针动画、模糊氛围背景、逐行歌词、音质/倍速切换、播放队列；切换音质为后台缓冲后无缝交接，播放不中断（切换失败保持原音质并提示）
- **搜索**：单曲/歌单/专辑/歌手，搜索历史
- **音源选择**：「我的 → 音源选择」统一入口（底部面板）——切换全局音源（发现/搜索/榜单/歌单共用，切换后各页自动刷新）、设/取消默认音源（冷启动优先，失败自动降级）
- **插件管理**：链接/本地文件安装、聚合订阅集导入、启用禁用、排序、用户变量、默认音源
- **设置**：主题（浅/深/跟随系统）、默认音质、记忆进度、伴生代理、备份与恢复（本地/WebDAV）
- **系统返回**：Android 返回键 / 全面屏返回手势、iOS 侧滑返回统一接管（`core/systemBack.ts`）——先收起浮层（播放页 / 播放队列 / 操作面板 / 对话框），再回退页面；已经在最外层则把应用退到后台（音乐继续播放），不会直接退出应用
- **其他**：迷你播放条、iOS 后台音频、锁屏/状态栏适配、Android 15+ edge-to-edge 沉浸式系统栏

## 开发

```bash
npm install
npm run dev        # http://localhost:5175 （手机可通过局域网访问）
npm run preview    # 预览构建产物（同样自带代理）
npm run proxy      # 可选独立代理（前端部署到不带代理的静态服务器时才需要）
```

浏览器调试时建议打开 DevTools 手机模拟（390×844）。

**浏览器端零配置**：dev / preview 服务器通过 `server/proxyCore.mjs` 在同源挂载了
`/ping` `/relay` `/media` 三个代理端点，应用启动时自动探测并启用——

- WebDAV 备份/恢复：服务端不支持 CORS 也能用（请求经同源中继）；
- 插件安装与 API 请求：被 CORS 拦截的音源（moro.cn.mt 等）正常工作；
- 媒体直链：需要 Referer / UA 的音源走 `/media` 中继（透传 Range，可拖进度）。

手动在「设置 → 网络」填写的伴生代理优先于内置代理；App（Capacitor）走系统网络栈，一律不使用代理。

测试音源：开发服务器运行时，在「插件管理」粘贴 `http://<本机IP>:5175/mock-plugin.js` 安装（内置音频与歌词，用于联调）。

## 打包为 App

前置要求：Android Studio（Android）、Xcode（iOS）。

```bash
npm run build            # 构建前端产物到 dist/
npm run cap:android      # 同步并打开 Android Studio
npm run cap:ios          # 同步并打开 Xcode
# 或手动：npx cap sync && npx cap open android|ios
```

### Android 命令行直接出包

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd android && ./gradlew assembleDebug    # 调试包 app-debug.apk
cd android && ./gradlew assembleRelease  # 签名正式包 app-release.apk
```

产物在 `android/app/build/outputs/apk/{debug,release}/`。Release 签名读取 `android/keystore.properties`
（`storeFile / storePassword / keyAlias / keyPassword`），密钥文件 `android/app/musicfree-hy.keystore`
已生成（storepass: `musicfreehy2024`，有效期 30 年）。**两者均已 gitignore，注意备份密钥**——
换密钥后无法覆盖安装旧版本。

原生工程（`android/`、`ios/`）已生成并配置好：

- 竖屏锁定、品牌图标与启动图（与 Pad 版同一只「戴耳机的猫」；`npm run gen:icons` 可从
  `assets/logo.png` 重新生成 web 图标与原生启动图/启动屏）
- iOS `UIBackgroundModes: audio`（后台播放）
- `CapacitorHttp` 已启用（原生网络直连，插件请求无跨域问题）

> Android 后台播放说明：WebView 音频在退到后台后可能被系统冻结，如需长期后台播放，
> 可在后续版本接入 `@capacitor-community/background-mode`（保持前台服务）。

## 目录结构

```
src/
├── core/            # 核心层（与 MusicFreeDesktop/Pad 同构）
│   ├── pluginHost.ts / pluginWorker.ts   # 插件沙箱（Worker + Function 构造器）
│   ├── native.ts / dav.ts                # Capacitor 原生桥 / WebDAV 备份
│   ├── trackPlayer.ts                    # 播放器（HTMLAudio + 音质降级 + MediaSession）
│   ├── musicSheet.ts / musicHistory.ts   # 歌单 / 历史（localStorage，与桌面端同 key）
│   ├── backup.ts / net.ts / mediaSource.ts
│   └── router.ts / theme.ts / uiAtoms.ts # 手机版 Tab 栈路由 / 主题 / 全局 UI 状态
├── components/
│   ├── base/         # 复用组件（MusicList、Cover、Slider、SourceSwitcher…）
│   └── layout/       # TabBar、MiniPlayer、NowPlaying、PlayQueuePanel
├── pages/            # home / myMusic / search / sheetDetail / albumDetail /
│                     # artistDetail / topList / topListDetail / history /
│                     # pluginManage / settings
└── styles/global.css # 手机版样式（max-width 520px，桌面浏览器打开即为手机观感）
public/mock-plugin.js # 本地测试音源
```

## 与桌面端的数据互通

- **备份导出/恢复**：设置 → 备份与恢复。导出的 JSON 可直接在 MusicFreeDesktop 恢复，反之亦然；
  支持追加 / 覆盖默认歌单 / 完整覆盖三种恢复模式。恢复摘要会点名装失败的音源及原因，
  播放失败时也会提示缺哪个平台的插件。
- **WebDAV**：与桌面端填同一账号（坚果云/Nextcloud/Alist/dufs 等），文件路径指向桌面端备份文件即可互传；
  浏览器端经内置代理中继，服务端不支持 CORS 也能用。
- **插件**：与桌面端一样按源码 sha256 识别，同一插件三端 hash 一致；插件包/订阅集通用。
  恢复备份时插件源码下载失败会自动回退备份内嵌的源码；Worker 挂载失败会把真实报错
  展示在插件管理页，便于排查。

## 版本

1.0.0

## iOS 真机调试

iPad（USB 连接）已配置好签名（Team `W6L82BPQT7`，自动签名 + 自动描述文件）：

```bash
./scripts/ios-run.sh            # 构建 → 同步 → 编译 → 安装 → 启动，一条命令
```

- WebView 调试：iPad 上打开 App 后，Mac 的 **Safari → 开发 → iPad → localhost** 可检查页面/网络/Console
- 设备日志：`xcrun devicectl device console --device <UDID> | grep MusicFree`
- 免费签名限制：每台设备最多 3 个免费签名 App（7 天有效），名额满时先卸载不用的
