# 原生播放内核重构：方案与实现要点

> 分支 `feat/native-playback-kernel`，对应提交：
> `ae0abc3` 全原生播放内核 → `3a150ab` 修崩溃 → `fb13dfa` 卡顿优化 → `0c44bc5` 修共播拉锯。
> 净变化：约 +1340 / -2160 行（删除旧机制多于新增）。
>
> **v1.0.12 更新**：本文的「队列窗口镜像」（§三）已升级为「队列计划下沉 +
> needsource 拉取协议」——原生持有完整播放顺序（shadow 队列），缺源时按需向
> JS 索要；同时落地**原生音源引擎（QuickJS `PluginRuntime`）**：needsource 并行
> 由服务自跑插件 `getMediaSource`，JS 冻结也能解析续播。现状与决策记录见
> `background-playback-design.md` §二.1/§二.2；本文保留重构历史与踩坑教训，
> §六协议表已按新接口更新。

## 一、要解决的问题

### 1.1 背景架构约束

音频源解析（插件 `getMediaSource`）历史上只能在 WebView 的 JS 里运行（音源插件机制；
v1.0.12 起另有原生 QuickJS 引擎兜底，见 §八.1），但熄屏后台的渲染进程会被 ROM 冻结——即使 `MainActivity` 把渲染进程钉为
`RENDERER_PRIORITY_IMPORTANT`（这只是建议），Chromium 对不可见页面仍有密集
唤醒节流与冻结。因此**「下一首放什么」的控制面不能依赖 JS 存活**。

### 1.2 旧架构的失效点（重构前实测）

| 症状 | 根因 |
|------|------|
| 后台播完一首就停，回 app 立刻续播下一首 | 结尾 30s 的预加载靠 JS `timeupdate` 触发；JS 冻结后预载从未落地，ExoPlayer 播完进 `STATE_ENDED` 静音；回前台对账逻辑探到 ended 才补发换歌 |
| 通知栏/耳机切歌失灵 | 播放列表里只有一首，原生无处可切；转发回 JS 的通路在冻结后死亡 |
| 回前台界面停在上一首 | 冻结期间的 transition 事件丢失，`isLoading` 标志被冻住卡死对账 |

### 1.3 后续版本迭代中发现的问题（重构后实测）

| 症状 | 根因 | 修复 |
|------|------|------|
| 播放器崩溃（`IllegalArgumentException`） | `removeMediaItems(from, to)` 第二参数误当「个数」传成 `count - from`，列表含已播条目后 `from > to` 触发 Media3 断言；旧架构列表最多 2 首，bug 恰好被掩盖 | `dropNextSources` 改传 `count`（排他结束下标） |
| 播放进度条消失 | 服务每秒发的 `timeupdate` 载荷为空，JS 快照永不更新 | 事件携带 `positionMs/bufferedMs/durationMs/paused` JSON 载荷，JS 解析 |
| getState/skip 线程违规崩溃 | Capacitor 插件方法跑在 `CapacitorPlugins` 线程，直接读 ExoPlayer（只许主线程） | `runOnMain` 统一切主线程执行后回填结果 |
| 播放一段时间后 app 异常退出 | `startForegroundService` 启动后 5s 内未进前台（JS 先起服务、后 loadTrack 的节奏超时），系统杀进程 | 改普通 `startService`，开播时由 Media3 自动晋升前台 |
| 偶发卡顿（欠载型） | 整首缓存下载与播放取流抢同一条带宽；开播初期缓冲水位未建立最敏感 | 开播 20s 静默窗 + 共播时下载分块节流（见 §四） |
| 抖音后台播放时反复暂停/启动 | ExoPlayer 默认参与音频焦点仲裁（共播开关默认关），抖音高频抢焦点 → `AUDIOFOCUS_LOSS` 自动暂停 → JS 巡逻 play() 拉起 → 循环 | 原生默认不入仲裁 + 删巡逻重试（见 §五） |

## 二、目标架构

```
前台 JS（音源解析、队列语义、历史、UI）
   │ loadTrack（当前曲 + 元数据）
   │ pushQueueWindow（已解析的接下来 4 首，含元数据）
   │ play / pause / seek / rate / volume / setAudioFocusMode
   ▼
PlaybackBridge 插件（Capacitor）
   │ 静态方法直调
   ▼
MediaPlaybackService（Media3 MediaSessionService 前台服务）
   ├─ ExoPlayer（OkHttp 数据源 / 30~60s 大缓冲 / WAKE_MODE_NETWORK）
   ├─ MediaSession（通知栏、耳机、蓝牙、锁屏——系统渲染，不经 JS）
   └─ 队列：[最近 2 首] + 当前 + 窗口（≤4 首），自动预缓冲、自动续播
```

核心思想：**所有「未来要播什么」的决定都在前台期做完并交给原生**。JS 冻结多久
都无所谓——原生队列照常自动预缓冲、自动逐首无缝续播，通知栏切歌/暂停/拖进度
全部由 Media3 直达播放器。

### 2.1 职责划分

| 层 | 职责 | 关键文件 |
|----|------|---------|
| JS trackPlayer | 播放语义（队列/历史/随机/待播）、音源解析、失败自救链、窗口镜像触发、回前台对账簿记 | `src/core/trackPlayer.ts` |
| JS nativeAudio | HTMLAudioElement 同形 facade：属性/事件映射原生桥；WebView `<audio>` 回退保留（浏览器 dev） | `src/core/nativeAudio.ts` |
| 原生 PlaybackBridge | JS→服务的薄封装；服务事件→JS 转发；电池优化/共播查询 | `PlaybackBridge.java` |
| 原生 MediaPlaybackService | ExoPlayer 生命周期、队列窗口管理、MediaSession、媒体通知、焦点模式、自动续播 | `MediaPlaybackService.java` |

### 2.2 已删除的旧机制

- `NativeAudioPlugin.java`、`MediaNotificationPlugin.java`（合并进 PlaybackBridge）
- 手写 MediaStyle 通知 + 封面解码器 + `ARTWORK_EXECUTOR`（Media3 自动渲染）
- `WakeLock`/`WifiLock` 心跳与 30s 保活 tick（ExoPlayer `WAKE_MODE_NETWORK` 自管）
- 手写 `AudioDeviceCallback` 拔耳机暂停（`setHandleAudioBecomingNoisy` 覆盖）
- WebView 静音保活 WAV（播放不再依赖 JS 存活，还省电）
- `setNextTrackMetaCache` 元数据预登记间接层（元数据随窗口条目自带）
- JS 共播续播巡逻（指数退避重试循环，见 §五）

## 三、核心机制：队列窗口镜像

### 3.1 数据流

1. **触发**（三个，全在前台期）：
   - 每首歌真正出声（`onAudioPlaying`）——主触发；
   - `visibilitychange → hidden`——冻结前最后确认；
   - 每次原生 transition 簿记完成 / 回前台对账后——补齐消耗掉的窗口。
2. **计算**：`computeUpcoming(4)` 按播放语义连算后续曲目——待播（下一首播放）
   优先，其次队列顺序；随机模式按「模拟消费」逐首选曲；单曲循环不进窗口
   （audio.loop / 原生 REPEAT_MODE_ONE 处理）；repeat off 的队尾之后封口。
3. **解析**：逐首 `resolveMediaUrl`（复用音质降级、本地下载判定、播放缓存判定、
   失败冷却 60s）。解析失败的单曲跳过，不阻塞后面的歌。
4. **推送**：`pushQueueWindow(items)` → 原生替换「当前曲之后」的全部条目。
   每条携带 `{mediaId, src, title, artist, album, artworkUri}`，通知栏直接可用。
5. **记录**：JS 侧 `mirroredWindow: Map<mediaId, IMirroredTrack>` 保存 resolved
   信息（音质、原始直链、来源），transition 簿记时复用，不重复解析。

### 3.2 原生侧队列维护（MediaPlaybackService）

```
[已播-2] [已播-1] [当前 ▶] [窗口1] [窗口2] [窗口3] [窗口4]
```

- `pushQueueWindow`：`dropNextSources()`（删当前之后全部）→ 逐条 `addMediaItem`（上限 4）。
- `onMediaItemTransition`：自动续播发生后删掉 `index - 2` 之前的条目——
  保持「最近 2 首 + 当前 + 窗口」，既支持原生直切「上一首」，列表又不无限增长。
- **注意**：`removeMediaItems(from, to)` 的 `to` 是**排他结束下标**，不是个数
  （`3a150ab` 崩溃的直接教训）。

### 3.3 自动续播的簿记（itemtransition）

原生自动续播时 JS 只需要「追认」，不需要触碰播放器：

1. 服务 `onMediaItemTransition` → `emitPlaybackEvent("itemtransition", mediaId, index)`
   → PlaybackBridge → JS。
2. `onItemTransition` 按 mediaId 查 `mirroredWindow`：
   - 命中 → `commitPreloadedNext`（队列/历史/atom/媒体会话簿记，翻「播放中」，
     手工清重试计数——过渡不产生 playing 事件）→ 立即补镜像；
   - 未命中（页面冻结期间推进过多首 / 队列被换过）→ 走 `reconcileWithNative`
     以原生现实对齐，绝不按过期记录回改状态。
3. 对账前先 `queryNativeState` 核对当前 mediaId，防止迟到事件按旧目标簿记。

### 3.4 窗口大小的取舍

4 首。后台连播上限 = 4 首 × 平均时长；窗口耗尽且 JS 仍冻结才停（硬边界）。
调大窗口 = 更多前置解析流量与失败面；正常使用下（每次 transition 都有前台
或 hidden 触发补镜像）窗口不会耗尽。

## 四、卡顿优化：缓存下载为播放让路

根因：整首缓存下载与播放取流抢同一条带宽，ExoPlayer 的 30~60s 缓冲水位在
开播初期尚未建立，取流被挤到实时速度以下即产生可听欠载。

### 4.1 开播静默窗（`audioCache.ts`）

- `notifyPlaybackStarted()` 在每次真正出声时打点（WebView `onAudioPlaying`
  与原生无缝过渡簿记两处）；
- 下载链路 `doStore` 入口轮询：`playbackStartedAt` 起 20s 内不开跑；
- 窗口内切歌会重置打点，等待中的任务续等不丢。

### 4.2 共播分块节流

- 原生 `PlaybackBridge.otherMediaPlaying`：`AudioManager.getActivePlaybackConfigurations()`
  数活跃媒体会话（只认 `USAGE_MEDIA`/`USAGE_GAME`，排除自家 ExoPlayer），结果缓存 10s；
- 下载改 Range 分块（256KB/块），块间查共播状态，>0 则停 120ms——把瞬时带宽
  让给播放取流；
- 服务器不支持 Range（HEAD 探测失败 / 无 `Accept-Ranges`）自动退化整包，功能不变。

### 4.3 原生直落磁盘（Android 主通道，`626fd0f`）

blob 过桥路径（`fetch → WebView 内存 Blob → FileReader base64 → JNI 逐块过桥 →
原生 decode → 磁盘`）是「后台打开其他应用明显卡顿」的根因：每首歌几十次
base64 编解码 + JSON 桥往返 + GC，WebView 主线程持续满载，新应用冷启动抢 CPU
时把调度尖峰放大成音频线程饥饿（纯原生播放器是 OkHttp 流式直写，成本差一个
量级且完全不碰 WebView）。

Android 播放缓存改走 `Storage.downloadFile`（歌曲下载已有的原生流式落盘通道：
HttpURLConnection 手动跟随跨协议重定向、.part 续传、5 路并发线程池）：

- 字节全程不过 JS 桥，WebView 在下载期间零参与；
- 扩展名先于下载确定（直链后缀 → HEAD 探测 content-type → 兜底 mp3）；
- 原生通道失败回退 blob 过桥路径（浏览器/iOS 语义不变）；
- 开播静默窗 / 切后台静默 / 共播节流语义照旧（节流只作用于回退路径）。

iOS 仍走 blob 路径（沙盒目录由 Filesystem 写入，量级可接受；后续可接入
`Download.downloadFile` 直落通道，`musicDownload.ts` 已有现成封装）。

## 五、共播与音频焦点策略

### 5.1 默认不入仲裁

`MediaPlaybackService.focusEnabled` 默认 `false`（`player.setAudioAttributes(attrs, false)`）：
- 音频焦点本就是建议性的，系统允许多流混音；
- 音乐 App 与短视频天然共场景，「被抢即停」没有正向价值（实测抖音每次切视频
  都抢焦点，独占模式下表现为反复暂停）；
- 设置页「允许与其他应用同时播放」= 关（默认，不入仲裁）；
  「独占播放」= 用户显式开启后 `focusEnabled=true`，别人开播我们让位。

### 5.2 状态恢复

服务可能被系统杀掉重建（`onCreate` 重新跑、`focusEnabled` 回到默认 false）。
JS 侧 `NativeAudioElement` 记住最近一次请求的模式（`_focusRequested`），随每次
`loadTrack` 随行重发——用户显式选择的独占模式在重建后也能恢复。

### 5.3 巡逻机制的移除

旧逻辑：被抢焦点 → 回抢 play() → 失败 → 指数退避巡逻重试（300ms→2s，45s 总长）
→ 与抖音的高频抢焦点形成「暂停↔启动」拉锯。移除后：
- 原生后端：不入仲裁，无外部 pause，巡逻无意义；
- WebView 后端（浏览器/老包回退）：被抢只静默回抢一次，抢不回保持暂停，
  由用户按播放继续——反复自动启动比让位更吵，与主流播放器行为一致。

## 六、桥接协议备忘

### 6.1 PlaybackBridge 方法（JS → 原生）

| 方法 | 参数 | 说明 |
|------|------|------|
| `isAvailable` | – | 探测（老包回退 WebView `<audio>`） |
| `ensureService` | – | `startService` 起播放服务（幂等；Media3 开播时自动晋升前台） |
| `loadTrack` | src, mediaId, startMs, autoplay, title, artist, album, artworkUri | 装载当前曲（替换整条列表，shadow 计划清空等重推）；焦点模式随行重发 |
| `pushQueuePlan` | items[{mediaId,src,title,artist,album,artworkUri}] | 整条播放计划入档（≤50，src 可空=未解析）；窗内条目按 mediaId 去重保留 |
| `supplySource` | mediaId, src | 补一条已解析音源；等源态下补上即自动续播 |
| `dropPlanned` | mediaId | 撤一条计划（解析失败冷却） |
| `play` / `pause` / `stop` | – | stop = 暂停并清空列表；play 在 ENDED 且有计划时补窗续播 |
| `seekTo` | positionMs | – |
| `skip` | direction: next/previous | 原生队列直切，返回切到的 mediaId（空串=无目标） |
| `jumpToItem` | mediaId | 计划内定点跳转（含 shadow 深处已解析条目）；未命中空串 |
| `setRate` / `setVolume` | rate/volume | – |
| `setRepeatMode` | repeatOne | 单曲循环原生处理；队列随机/顺序由 JS 算计划 |
| `setAudioFocusMode` | focusEnabled | 缺省 false（不入仲裁） |
| `getState` | – | available/hasPlayer/currentMediaId/currentSrc/positionMs/bufferedMs/durationMs/paused/ended/playing/hasNext/awaitingSource/plannedCount/rate/volume |
| `ensurePermission` | – | Android 13+ 通知权限一次请求（FGS 晋升前提） |
| `otherMediaPlaying` | – | 活跃媒体会话数（排除自家），共播让路用 |
| `isBatteryOptimizationIgnored` / `requestIgnoreBatteryOptimizations` | – | 自原 MediaNotificationPlugin 迁入 |

### 6.2 audioEvent 事件（原生 → JS）

| type | 载荷 | 语义 |
|------|------|------|
| `play` / `pause` / `playing` | mediaId | playWhenReady/isPlaying 变化 |
| `ended` | mediaId | STATE_ENDED（队列无下一首时才会出现） |
| `error` | detail=errorCode | PlaybackException（JS 映射成 HTMLMediaError.code） |
| `timeupdate` | positionMs, bufferedMs, durationMs, paused | 播放中每 1s |
| `durationchange` | durationMs | STATE_READY 时 |
| `itemtransition` | mediaId, index | 自动续播/直切后的簿记信号 |
| `needsource` | mediaId（shadow 队头）, plannedCount | 队列推进缺音源，向 JS 索要（1.5s 首发 + 12s 周期重发） |

### 6.3 线程规则（反复踩坑的教训）

**ExoPlayer 所有访问必须在创建线程（主线程）**。Capacitor 插件方法跑在
`CapacitorPlugins` 线程——所有插件方法一律经 `svc.runOnMain(...)` 转投：
写操作 fire-and-forget，读操作（getState/skip）转主线程执行后回填 `call.resolve`。
服务回调（Player.Listener）本身在主线程，可直接读。

## 七、验证清单（真机）

- [x] 播放中进度条走动、时长正确
- [x] 通知栏：当前曲标题/封面、上一首/下一首/暂停、拖进度
- [x] 锁屏后台连播（窗口自动续播，播完一首接着下一首）
- [x] 切歌/队列增删/随机模式/单曲循环回归
- [x] 与抖音共播：本应用不被打断，不再反复暂停/启动
- [x] 崩溃复现路径（连续切歌触发窗口重镜像）不再触发
- [ ] 长时间后台（>窗口总时长）后回前台：界面与播放器状态对齐
- [ ] 熄屏 WiFi 弱网下的断流自救与回前台补播

## 八、已知边界

1. ~~后台连播上限为窗口 N 首~~（v1.0.12 起由 shadow 计划 + needsource 拉取接管：
   JS 只要在 12s 重发周期内能醒一瞬即可整队续播；被彻底长期冻结时由**原生
   QuickJS 音源引擎**（`PluginRuntime`）拿计划 payload 自解析续播——「原生侧
   预解析」这一硬边界已消除，详见 `background-playback-design.md` §二.2）。
2. Android 切音质为「原位重挂」（单实例 ExoPlayer，双播放器会顶掉在播的歌），
   大缓冲下间隙极短；WebView 后端保留双 `<audio>` 无缝交接。
3. WebView `<audio>` 后端（浏览器 dev）仍走旧的 probe 预载路径，行为不变。
4. 通知划掉 = 暂停（Media3 默认语义）；彻底关闭走应用内「关闭」按钮。
5. 老包升级安装：`PlaybackBridge` 是新插件，旧 JS 在新包上跑不了（同 APK 一起
   发版，无兼容问题；`isAvailable` 探测仅用于浏览器 dev 回退）。
