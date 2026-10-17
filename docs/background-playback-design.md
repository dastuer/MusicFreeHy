# 后台播放设计与实现现状（截至 v1.0.15）

> 本文是后台播放子系统的**当前真实状态**与历史决策记录，供后续优化接续。
> 演进脉络：v1.0.7 全原生播放内核重构 → v1.0.8~1.0.10 后台连播多轮修复 →
> v1.0.11 预载收敛为「只预载下一首」→ **v1.0.12**（一次发布三件事）：窗口 2→3 +
> 手动点播快路径、**播放队列整体下沉原生（shadow 计划 + needsource 拉取协议）**、
> **原生音源引擎（QuickJS 自解析，L4 终局方案）** → **v1.0.14**：删除无效的
> WebView 保活两层、补齐 QuickJS 环境（fetch/TextDecoder）、原生解析换源自愈、
> 队列快照落盘 + `onPlaybackResumption` → **v1.0.15（架构收口）**：
> **整条队列进 ExoPlayer + 惰性解析数据源**，shadow 计划/可播窗/needsource
> 那一整套状态机全部删除；**shuffle/repeat 下沉原生**。
> 主要提交：`ae0abc3`（内核重构）、`3a150ab`（修崩溃）、`fb13dfa`/`b57a84b`/`626fd0f`（卡顿三层优化）、
> `0c44bc5`（共播）、`f83bc9b`（通知暂停）、`ff7ba9f`/`31d4881`（窗口本地化与分层）、
> `89aae3f`+`c44f54c`（删预载又还原，最终保留）、`af16279`（窗口 6→2）。

## 一、架构总览（v1.0.15）

```
WebView JS（遥控器）：队列语义/历史/UI/缓存预热
   │ PlaybackBridge 桥：setQueue / supplySource / dropPlanned / loadTrack /
   │                     setPlaybackOrder / 控制 / getState
   ▼
MediaPlaybackService（Media3 MediaSessionService 前台服务，Android 原生）
   ├─ **整条队列就是 ExoPlayer 的播放列表**（不再是「计划快照 + 可播窗」）
   ├─ 惰性解析（LazyAudioDataSource）：缺源条目以占位 URI `mfhy://<mediaId>`
   │   进列表，ExoPlayer 预缓冲到它时才跑 QuickJS 拿真实直链
   │   —— 解析时机贴近播放，**直链不过期**；解析在主线程与 JS 之外完成
   ├─ 顺序/循环归原生：ShuffleOrder（随机）+ REPEAT_MODE_OFF/ALL/ONE
   ├─ 换源自愈：取流失败 → 清该条解析缓存 → prepare 重新解析（首次带
   │   excludeUrl）；重试上限后跳下一首；连续多首失败才停
   ├─ 队列快照（v1.0.14 起）：整队 + 当前索引/位置/模式/焦点落盘，
   │   冷启动 restoreQueueState 挂回（不自动开播）+ onPlaybackResumption
   ├─ ExoPlayer：OkHttp 数据源 / 30~60s 大缓冲 / WAKE_MODE_NETWORK /
   │   音频硬件直通（offload）+ 输出缓冲 1~2s（回退路径）
   │   └─ ResolvingDataSource：按 URI 注入插件返回的请求头
   └─ MediaSession：通知栏、耳机、蓝牙、锁屏（系统渲染，不经 JS）
```

**与 v1.0.12~1.0.14 的关键差别**：那时原生只持有「接下来 50 首的计划快照」，
可播窗 3 首、缺源靠 `needsource` 向 JS 索要或 QuickJS 兜底、窗口耗尽就停摆。
现在队列本身就是播放列表，**没有「窗口」这个概念**——连播长度、解析时机、
顺序全部由播放器自己的加载与推进机制决定。

关键文件：
- `android/.../MediaPlaybackService.java` — 播放内核（整条队列入播放器/惰性解析接入/换源自愈/队列快照恢复/媒体恢复/通知/焦点）
- `android/.../LazyAudioDataSource.java` — **惰性解析数据源**（占位 URI → 临播前解析真实直链）
- `android/.../PlaybackBridge.java` — JS↔服务桥 + 通知权限 + 电池优化 + 共播查询
- `android/.../PluginRuntime.java` / `PluginRuntimeBridge.java` — QuickJS 引擎、插件落盘回灌、阻塞 resolve
- `src/native/nativeRuntimeEntry.ts` — 原生运行时 bundle 入口（polyfill/同步 HTTP/fetch 适配/`__sync/__tick` 协议）
- `src/native/quickjsPreload.ts` — 「必须先于依赖求值」的全局补丁（atob/btoa/Buffer/TextDecoder）
- `src/core/nativePluginRuntime.ts` — 插件源码同步到原生（去抖 800ms + 并发合并）
- `src/core/trackPlayer.ts` — 队列语义/队列推送（setQueue）/transition 簿记/缓存预热/UI
- `src/core/nativeAudio.ts` — HTMLAudioElement 同形 facade（setQueue / setPlaybackOrder）
- `src/core/audioCache.ts` — 播放缓存（原生直落磁盘主通道）

## 二、核心机制（当前生效）

### 2.1 整条队列进 ExoPlayer + 惰性解析（v1.0.15 定稿）

JS 经 `setQueue(items, currentMediaId, shuffle, mode)` 把**整条队列**交给原生，
原生侧它就是 `player.setMediaItems(...)` 的列表本身。

缺源条目（JS 没给 src）以**占位 URI** `mfhy://<mediaId>` 进列表。ExoPlayer 预缓冲
到它（通常比实际出声早 30~60s）时，`LazyAudioDataSource.open()` 认出这个 scheme，
在**加载线程**上调用服务的 `resolveForPlayback(mediaId)`：
先看 JS 给的 src / 已解析缓存，都没有就用该条目的 `payload` 跑 QuickJS
`getMediaSource`（同步原生 HTTP），拿到直链后原地改写 DataSpec 继续 open。

由此消除的旧机制（v1.0.12~1.0.14 的一整套）：
| 旧机制 | 现在为什么不需要 |
|---|---|
| shadow 计划队列 | 队列本身就在播放器列表里 |
| `QUEUE_WINDOW_MAX=3` 可播窗 + `refillWindow` | 播放器自己管理缓冲与推进 |
| `needsource` 拉取协议（1.5s/12s 周期性向 JS 索源） | 解析在数据源层按需完成，不问 JS |
| `awaitingSource` 等源态 + `autoResumeIfAwaiting` | 解析失败即抛 IOException → 跳歌自愈 |
| `PLAN_MAX=50` 推送截断 | 队列整条进（上限 2000 防误推） |
| `supplyPlannedSources`（JS 主动补源救场） | 改为纯优化：`warmQueueCache` 只预热缓存 |

**解析时机**是这次改动最大的收益：旧实现推送队列时就解析（队列深处的直链可能
躺几小时过期），现在是「预缓冲到才解析」——实测日志中第 3/4 首在某一刻一起解析、
第 5/6 首到 30 秒后才解析，与播放进度严格对应。

### 2.2 顺序与循环归原生（v1.0.15）

`setPlaybackOrder(shuffle, mode)`：
- `mode="off"` → `REPEAT_MODE_OFF`（顺序，队尾停）
- `mode="queue"` → **随机播放**（即 UI 的 shuffle 图标）+ `REPEAT_MODE_ALL` 整队循环
- `mode="single"` → `REPEAT_MODE_ONE` 单曲循环
- `shuffle=true` 时 `setShuffleOrder(new DefaultShuffleOrder(...))` + `setShuffleModeEnabled(true)`

JS 侧 `computeUpcoming` 的「模拟消费算顺序」不再是播放的必经路径（仅在
WebView 后端的 probe 预载与 UI 预览里还用到）。`hasNext`/`plannedHead` 由
`player.getNextMediaItemIndex()` 直接给出，**shuffle 下的「下一首」天然正确**
（旧实现靠 JS 约定维持一致性，是文档里记过的隐患之一）。

### 2.3 换源自愈（简化版）

`onPlayerError` 里只需三步：记下失败直链 → 清掉该条目的解析缓存 → `prepare()`
重新触发惰性解析（首次带 `excludeUrl` 让插件换源）。重试上限 `MAX_RESOLVE_RETRIES=2`
用尽才跳下一首；连续 `MAX_CONSECUTIVE_ERRORS=5` 首失败才真正停下。

比 v1.0.14 的 `retryCurrentTrackNatively` 简单得多——那时当前曲不在计划里、
要单独维护一套 payload 与重试状态；现在「当前曲」就是队列条目，"重新解析"
就是清缓存，同一套逻辑覆盖所有位置。

### 2.4 队列快照与媒体恢复

落盘 `filesDir/playback-queue.json`：整队（含 payload/quality）+ 当前索引 +
位置 + `mode`/`shuffle`/焦点模式。触发：队列变动去抖 1.2s、播放中每 30s、
暂停即写、`onDestroy` 兜底；`stop()`/清空队列 → 删文件。
恢复：`onCreate` 的 `restoreQueueState`（不自动开播）+ `onPlaybackResumption`
（系统媒体恢复卡片，需要开播）。缺 src 的条目挂占位 URI，播放时重新惰性解析。

### 2.5 手动点播与切歌

整队都在播放器列表里，所以 JS 的手动点播就是 `jumpToItem(mediaId)` → `seekTo(index)`
——不再有「计划深处要先撤下前面的条目」那回事。通知栏/耳机/蓝牙切歌由 Media3
直达播放器，与 JS 无关。

### 2.6 原生音源引擎（QuickJS 自解析）

- **引擎**：`wang.harlon.quickjs:wrapper-android:3.2.0`（预编译 .so，免 NDK/CMake）；
  单线程 context（绑定创建线程即注入，别跨线程），`evaluate/call` 后手动
  `executePendingJobQueue` 排干微任务，自动注入 console + Date。
- **运行时 bundle**：`src/native/nativeRuntimeEntry.ts` 经
  `scripts/build-native-runtime.mjs` 打成 `assets/native-plugin-runtime.js`
  （≈560KB，`npm run build` 自动产出）：与 WebView 同源的插件沙箱
  （`pluginSandboxCore`）+ QuickJS 缺失全局 polyfill + **同步** `__nativeHttp`
  （Java OkHttp，宿主线程阻塞）+ `__tick` 驱动的定时器 + **fetch 适配**
  （v1.0.14 起，此前是硬拒绝；插件直接用 fetch 的也能在原生跑）。
  坑：`atob/btoa/Buffer/TextDecoder` 必须由 `quickjsPreload.ts` 在**首个 import**
  注入——依赖在模块初始化阶段就会摸这些全局。
- **插件同步**：安装/卸载/启停/变量/默认音源变化 → `pluginHost` 钩子 →
  `nativePluginRuntime.ts` 去抖 800ms `syncPlugins`（`sha256(code)` + 源码 + 元数据）
  → 原生落盘 `filesDir/native-plugin-runtime/plugins.json`，冷启动 `ensureReady` 回灌。
- **解析入口**：`PluginRuntime.resolve(payload, quality, excludeUrl, timeout)`，
  音质阶梯与 `pickSupportedQuality` 与 JS 侧一致；返回 `{ok:true, url, headers,
  userAgent, quality}`——**字段是 `url` 不是 `src`**；`localPath` 直返 `file://`。
- **请求头**：`ResolvingDataSource` 按 URI 注入插件返回的 headers（≤128 条）。
- **验证**：`node scripts/test-native-runtime.mjs`（真实 bundle 在 QuickJS 里跑
  axios→原生 HTTP / fetch 插件 / TextDecoder / 降档 / excludeUrl / 定时器 / 错误透传）。

### 2.7 共播与音频焦点

ExoPlayer **默认不入音频焦点仲裁**（`focusEnabled=false`）：抖音等高频抢焦点
应用不会打断播放。设置页「允许与其他应用同时播放」开 = 不入仲裁（默认）；
关 = 独占（别人开播我们让位）。焦点模式随每次队列推送与 `loadTrack` 重发
（服务重建后恢复用户选择）。非 JS 发起的 pause 一律视为用户意图。

### 2.8 播放缓存（原生直落磁盘）

- 主通道：`Storage.downloadFile`（HttpURLConnection 手动跟随跨协议重定向、
  .part 续传、5 路并发）——**字节不过 JS 桥**，WebView 零参与；
- 回退：blob 过桥路径（Range 分块 256KB/块，共播时块间停 120ms）；
- 静默窗：开播 20s 内不下载（缓冲水位优先）、切后台 8s 内不下载；
- 索引在 localStorage（`audioCache.index`），文件在 `cacheDir/audio-cache`；
- 落盘 → `upgradePlanToLocal` 经 `supplySource` 把队列条目就地换成本地文件。

### 2.9 性能

后台播放时「打开其他应用就卡顿」的根因是**应用 CPU 被对方冷启动抢占**：
普通解码路径下渲染/灌音线程要被调度才出声，被饿死即欠载。两层应对：

- **音频硬件直通（Audio Offload，v1.0.15 新增，默认开）**：`ExoPlayer` 经
  `TrackSelectionParameters#setAudioOffloadPreferences`（`AUDIO_OFFLOAD_MODE_ENABLED`，
  gapless/倍速要求均为 false）把 MP3/AAC/FLAC 等交给 DSP 解码，硬件按自己的
  时钟推进、几乎不吃应用 CPU——其他应用冷启动抢 CPU 也压不垮。仅设备与格式
  都支持时生效，否则 Media3 自动回退普通解码（无副作用）。用户改倍速时自动
  回退。设置页「硬件音频直通（后台防卡顿）」可关（个别 ROM 直通有兼容问题）。
  开关随队列快照落盘（`audioOffload` 字段）并在服务重建后重申。
- **输出缓冲 1~2s**（`DefaultRenderersFactory.buildAudioSink` 覆写
  `setMinPcmBufferDurationUs(1s)` / `setMaxPcmBufferDurationUs(2s)`）——**回退
  路径**（格式不支持直通时）抗调度尖峰的主力，替代此前的 500ms；Software-only
  解码时靠它顶着出声。注意 offload 走独立的 50s 预灌缓冲，不经过这里的 PCM
  缓冲设置；
- ~~WebView 静音保活 WAV + MainActivity 钉 renderer IMPORTANT~~（v1.0.14 删除）：
  实测对 renderer 冻结无效，续播可靠性完全由原生侧承担；
- `ensureService` 用普通 `startService`（前台服务 5s 超时被杀的教训），
  开播时 Media3 自动晋升前台；**前提是通知权限已授予**——未授予时 Media3 无法
  发前台通知，服务不进 FGS，熄屏约 90s 被系统回收。首播时会弹一次系统授权框；
- ExoPlayer 全部访问必须在主线程：插件方法经 `svc.runOnMain` 转投，
  读操作（getState/skip/jumpToItem）转主线程后回填 resolve；
  **惰性解析在 ExoPlayer 加载线程**上跑（不占主线程，也与 JS 无关）。

### 2.10 回前台对账

以 `getState` 的原生现实为准校准 JS：曲目对齐（含收养分支：JS 无源但原生在播）、
播放态对齐、`isLoading` 卡死清理（>45s）、按需重推队列。

## 三、桥接协议备忘

| 方法 | 说明 |
|------|------|
| loadTrack(src,mediaId,startMs,autoplay,title,artist,album,artworkUri,**payload,quality**) | 装载当前曲（替换整条列表，shadow 计划一并清空等重推）；焦点模式随行重发；payload/quality 是当前曲的换源自救依据（v1.0.14） |
| pushQueuePlan(items≤50) | 整条播放计划入档（元数据 + src 可空）；窗内条目保留不动，其余替换 shadow |
| supplySource(mediaId,src) | 补一条已解析音源（needsource 往返/落盘本地化）；等源态补上即自动续播 |
| dropPlanned(mediaId) | 撤一条计划（解析失败冷却）；shadow 与窗内命中都移除 |
| play/pause/stop/seekTo/setRate/setVolume/setRepeatMode/setAudioFocusMode | 直达播放器（play 在 ENDED 且有计划时自动补窗续播；IDLE 且列表非空时先 prepare——队列快照恢复的场景） |
| skip(direction) | 原生队列直切，返回切到的 mediaId（空=无目标） |
| jumpToItem(mediaId) | 原生队列定点跳转（计划内已解析条目，含 shadow 深处）；命中返回 mediaId，未命中空串 |
| getState | currentMediaId/currentSrc/positionMs/bufferedMs/durationMs/paused/ended/playing/hasNext/**awaitingSource/plannedCount**/plannedHead/rate/volume |
| ensurePermission | Android 13+ 通知权限一次到位（首播时 JS 触发；FGS 晋升前提） |
| otherMediaPlaying | 活跃媒体会话数（排除自家），缓存下载共播让路用 |

事件（audioEvent）：play/pause/playing/ended/error(detail 可带 `|skip`)/
timeupdate(每 1s 带数值载荷)/durationchange/itemtransition(mediaId,index)/
**needsource(mediaId=shadow 队头, plannedCount；1.5s 首发 + 12s 周期重发)**。

## 四、已知边界与遗留问题（新窗口的优化空间）

1. ~~**后台连播上限 = 窗口 3 首**~~（v1.0.12 队列计划下沉后取消）：连播长度不再
   受窗口大小限制——只要 JS 在 needsource 重发周期（12s）内哪怕醒一瞬，整队都能
   续下去；**JS 被彻底长期冻结也不再停摆**：原生音源引擎（§2.2）拿计划条目自带的
   payload 自解析续播，不再只有「已补源的 ≈3~4 首」。可播窗 `QUEUE_WINDOW_MAX=3`
   现在只影响预缓冲深度与通知栏预览长度，与「连播上限」解耦。
2. ~~**直链时效 vs 本地化进度赛跑 / 整窗重推**~~（v1.0.12 解决）：补源发生在
   「临播前一两首」，直链过期面收窄；缓存落盘经 `supplySource` 逐曲就地替换
   （窗内 `replaceMediaItem`），不再整窗重镜像。
3. ~~**原生侧无预解析能力**~~（v1.0.12 L4 解决）：音源解析不再必须在 WebView 里跑，
   QuickJS 引擎承接 `getMediaSource`（§2.2）。残余边界：只有 `getMediaSource` 下沉，
   搜索/歌单/变量等插件回调仍需 JS；解析仍是 JS 优先、原生 2.5s 后接管，
   解析失败靠 8s×3 重试 + 坏条目自愈兜底。
4. **Web MediaSession 与原生通知并存**：Android 上 `updateMediaSession` 仍写
   navigator.mediaSession（无实际渲染方），可裁剪。
5. **`computeUpcoming` 与 `computeNextMusicItem`/`getNextIndex` 取歌语义三处
   相似实现**，随机模式一致性靠约定，值得合并成单一来源。
6. **验证缺口**：长时间后台（>窗口总时长）回对账、弱网断流自救，只有模拟器
   局部验证，缺真机长时回归。
7. ~~**通知权限未主动引导**~~（已实现）：`POST_NOTIFICATIONS` 被拒时 Media3 无法
   晋升前台服务，熄屏约 90s 被 `Stopping service due to app idle` 回收（§二.7）。
   `PlaybackBridge.ensurePermission`（Android 13+ 原生弹一次系统授权框）已由
   `mediaNotification.ensurePermissionOnce` 在首次进入播放态时触发；用户拒绝仍
   可在系统设置里补开。
8. **Doze 全冻结未验证**：本轮模拟器测试刻意保持 AC 供电（`dumpsys battery set ac 1`）
   避开了 Doze；真机电池供电长时熄屏下系统冻结策略更严，属 §四.6 真机回归缺口。
9. ~~**原生换源自愈不带 excludeUrl**~~（v1.0.14 解决）：`onPlayerError` 记下失败的
   直链，原生重解析首次作 `excludeUrl` 传给插件；当前曲另有原地换源路径（§2.9）。
   残余边界：**从第 2 次重试起不再排除**（防「唯一源被永久排除」，见 §2.9），
   所以插件若只提供一条坏源，仍会烧完 3 次机会后跳歌。
10. ~~**进程被杀 = 队列丢失**~~（v1.0.14 解决）：队列快照落盘 + `onCreate` 恢复 +
    `onPlaybackResumption`（§2.10）。
11. **L4 只覆盖「缺源」场景的 E2E**：模拟器冻结注入已验证，真机长时后台 + 弱网 +
    直链过期组合（§四.6/§四.8）仍是回归缺口。
12. **fetch polyfill 只覆盖文本响应**：`__nativeHttp` 是文本进文本出的宿主接口，
    `res.arrayBuffer()` 按 latin1 逐字节还原。插件若对二进制响应做解析（罕见）
    可能拿到错误数据，需扩宿主接口为 base64 传输。
13. **队列快照恢复后不自动开播**：进程被杀重启后面板显示上次队列、停在暂停态，
    需用户点播放（或从系统媒体恢复卡片）。这是有意选择（与原生播放器语义一致），
    若希望「开机自动续播」需另做开关。
14. **硬件直通（offload）缺机型覆盖验证**：offload 在设备与格式都支持时启用，
    不支持自动回退；`AudioOffloadListener` 的「已启用/回退」日志可用来确认某
    机型/某音源是否真的走了直通。少数 ROM 直通实现有兼容问题（无声/爆音），
    设置页开关可关。真机长时后台 + 弱网 + 直通组合仍需回归（接 §四.6）。

## 五、验证方式速查

- 无线调试：手机开「开发者选项→无线调试」→ `npm run android:connect`（mDNS
  失效时扫端口：`nc -z 192.168.1.3 <port>` 批量探）；
- WebView 注入调试：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
  后用 DevTools 协议 `Runtime.evaluate` 直调 `Capacitor.nativePromise`；
  debug 包另有现成脚本 `scripts/cdp-eval.mjs`（表达式求值/截图/重载）；
  debug 构建暴露 `window.__tp`（TrackPlayerSingleton）、`window.__pluginHost`、
  `window.__invalidatePluginCache`，可直接造队列（`__tp.addAll/play`）、装测试插件、
  查 `planEntries/planSources`；release 构建摇树剔除；
- 端到端连播回归配方（v1.0.12 验证所用）：`npm run android:live`（dev 构建才有
  调试钩子）→ 宿主机 `python3 -m http.server` 挂几首 25s 短音频（ffmpeg sine 即可，
  模拟器内 `10.0.2.2:<port>`）→ `__pluginHost.installPluginCode(<返回这些直链的插件>)`
  → `__tp.addAll(list); __tp.play(list[0])` → 熄屏用 `dumpsys media_session` 轮询
  `description=`/`state=` 观察原生推进（不依赖 JS 存活）；坏链条目用返回 404 URL 的
  假音源（如 id=999 → /missing.m4a）验证自愈跳过；
- 原生引擎冒烟（改 `nativeRuntimeEntry.ts` / `quickjsPreload.ts` / bundle 后必跑）：
  `node scripts/test-native-runtime.mjs`——真实产物在 QuickJS 里跑 axios→原生 HTTP、
  音源降档、excludeUrl、定时器 `__tick`、错误透传、增量同步，**外加 fetch 插件
  （方法/请求头/body 透传、非 2xx 判定）与 TextDecoder**，全绿才算过；
- 冻结页面模拟（L4 验证）：`node scripts/cdp-eval.mjs --freeze` / `--thaw`
  （`Page.setWebLifecycleState`），配合 `adb logcat -s PlaybackService` 看
  「原生自解析发起/成功」与媒体会话是否在冻结期自动切歌续播；
- 队列快照恢复验证（v1.0.14）：
  造队列开播 → `adb shell am force-stop <pkg>` → 重启 App →
  `adb logcat | grep 队列快照` 应见「队列快照恢复：N 首可播 + M 首待补源，停在索引 i」，
  再用 `Capacitor.nativePromise("PlaybackBridge","getState")` 核对 currentMediaId/paused；
  快照文件在 `filesDir/playback-queue.json`（`run-as <pkg> cat` 可查看；
  `stop()` 后应被删除）；
- 当前曲换源验证（v1.0.14）：`loadTrack` 传一条 404 的 src，但 payload 指向一个
  能解析出可用直链的曲目 → 日志应见「当前曲换源重试 → 当前曲换源成功，原地续播」，
  且 `getState` 的 currentSrc 变成新直链、仍在播（不跳歌）；
- 直链过期模拟（v1.0.14）：把正在播队列的后续音频文件改名（HTTP 返回 404）→
  原生应走「换源重试 → 换不出跳下一首」，不是停在坏条目上；恢复文件后重新造队列即可；
- 模拟器注意：`pm grant <pkg> android.permission.POST_NOTIFICATIONS` 必须先行
  （§四.7）；`dumpsys battery set ac 1 level 100` 保持供电避免 Doze 干扰计时；
- release 包无调试钩子（`window.__tp` 被摇树剔除）：E2E 直接用
  `Capacitor.nativePromise("PlaybackBridge", method, params)` 驱动桥即可，
  这恰好覆盖「JS 只是遥控器」这条链路的真实契约（v1.0.14 验证即用此法）；
- 崩溃：`adb logcat -b crash`；npm 用 nvm 的（pyenv shim 的 npm 坏）：
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`；
- 发版：`node scripts/release.mjs <版本> --notes "..."`（需 GITEE_TOKEN，在 ~/.zshrc）。
