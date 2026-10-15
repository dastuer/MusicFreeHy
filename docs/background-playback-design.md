# 后台播放设计与实现现状（截至 v1.0.14）

> 本文是后台播放子系统的**当前真实状态**与历史决策记录，供后续优化接续。
> 演进脉络：v1.0.7 全原生播放内核重构 → v1.0.8~1.0.10 后台连播多轮修复 →
> v1.0.11 预载收敛为「只预载下一首」→ **v1.0.12**（一次发布三件事）：窗口 2→3 +
> 手动点播快路径、**播放队列整体下沉原生（shadow 计划 + needsource 拉取协议）**、
> **原生音源引擎（QuickJS 自解析，L4 终局方案）** → **v1.0.14**：删除无效的
> WebView 保活两层、补齐 QuickJS 环境（fetch/TextDecoder）、原生解析换源自愈
> （excludeUrl + 当前曲原地重解析）、**队列快照落盘 + `onPlaybackResumption`
> 媒体恢复**（进程被杀不再丢队列）。
> 主要提交：`ae0abc3`（内核重构）、`3a150ab`（修崩溃）、`fb13dfa`/`b57a84b`/`626fd0f`（卡顿三层优化）、
> `0c44bc5`（共播）、`f83bc9b`（通知暂停）、`ff7ba9f`/`31d4881`（窗口本地化与分层）、
> `89aae3f`+`c44f54c`（删预载又还原，最终保留）、`af16279`（窗口 6→2）。

## 一、架构总览

```
WebView JS（遥控器）：音源解析（插件 getMediaSource）、队列语义、历史、UI、缓存下载调度
   │ PlaybackBridge 桥：pushQueuePlan / supplySource / dropPlanned / loadTrack / 控制
   ▼
MediaPlaybackService（Media3 MediaSessionService 前台服务，Android 原生）
   ├─ 队列推进状态机归原生：ExoPlayer 可播窗 [已播≤2] + [当前] + [预载≤3]
   ├─ shadow 计划队列：完整播放顺序（元数据 + src 可空），播完自动从窗续播
   ├─ needsource 拉取协议：轮到缺源条目时向 JS 索要（1.5s 首发 + 12s 周期重发），
   │   JS 醒来经 supplySource 补源 → 等源态当场自动续播（不依赖回前台对账）
   ├─ 原生音源引擎（QuickJS `PluginRuntime`，v1.0.12；v1.0.14 补 fetch/TextDecoder）：
   │   计划条目带 payload/quality，服务自行跑插件 getMediaSource（同步原生 HTTP）；
   │   解析泵一次排前 3 条（NATIVE_RESOLVE_LOOKAHEAD），不等队头逐条串行
   ├─ 换源自愈（v1.0.14）：取流失败按 mediaId 记坏直链，重解析时首次作 excludeUrl
   │   传给插件（第 2 次起允许复用，防「唯一源被永久排除」）；当前曲走
   │   retryCurrentTrackNatively 原地换源续播，换不出才跳歌
   ├─ 队列快照（v1.0.14）：shadow + 窗内条目 + 当前索引/位置/循环模式落盘
   │   （filesDir/playback-queue.json，去抖 1.2s、播放中每 30s、暂停即写），
   │   冷启动 restoreQueueState 挂回（不自动开播），系统恢复走 onPlaybackResumption
   ├─ ExoPlayer：OkHttp 数据源 / 30~60s 大缓冲 / WAKE_MODE_NETWORK / 输出缓冲≥500ms
   │   └─ ResolvingDataSource：按 URI 注入原生解析返回的请求头（≤64 条）
   └─ MediaSession：通知栏、耳机、蓝牙、锁屏（系统渲染，不经 JS）
```

关键文件：
- `android/.../MediaPlaybackService.java` — 播放内核（shadow 计划/补窗/等源续播/原生自解析/解析泵/换源自愈/队列快照恢复/媒体恢复/通知/焦点）
- `android/.../PlaybackBridge.java` — JS↔服务桥 + 通知权限 + 电池优化 + 共播查询
- `android/.../PluginRuntime.java` / `PluginRuntimeBridge.java` — QuickJS 引擎、插件落盘回灌、阻塞 resolve
- `src/native/nativeRuntimeEntry.ts` — 原生运行时 bundle 入口（polyfill/同步 HTTP/fetch 适配/`__sync/__tick` 协议）
- `src/native/quickjsPreload.ts` — 「必须先于依赖求值」的全局补丁（atob/btoa/Buffer/TextDecoder）
- `src/core/nativePluginRuntime.ts` — 插件源码同步到原生（去抖 800ms + 并发合并）
- `src/core/trackPlayer.ts` — 播放语义/计划推送（payload+quality）/按需补源/对账/失败自救
- `src/core/nativeAudio.ts` — HTMLAudioElement 同形 facade（含当前曲自救快照 `setTrackRecovery`）
- `src/core/audioCache.ts` — 播放缓存（原生直落磁盘主通道）

## 二、核心机制（当前生效）

### 2.1 队列计划下沉 + needsource 拉取（v1.0.12 定稿，取代「窗口镜像」）

JS 不再「前台解析好 3 首推进窗口」，而是把**整条播放计划**（`computeUpcoming(PLAN_MAX=50)`
的完整顺序 + 元数据，已解析条目带 src、未解析带空串）经 `pushQueuePlan` 交给原生
shadow 队列。**「下一首放什么、播完往哪推进」的状态机就此归原生**，JS 退化为遥控器：

- 原生 `refillWindow`：始终把 shadow 头部的已解析条目补进 ExoPlayer 可播窗
  （当前曲之后 ≤`QUEUE_WINDOW_MAX=3` 首，兼作通知栏「下一首」预览位）；
- 可播位不足且 shadow 头部缺源 → 向 JS 发 `needsource`（1.5s 首发、12s 周期重发，
  覆盖 JS 强节流/冻结醒来的场景）；JS `supplyPlannedSources` 按计划顺序解析
  （前瞻 3 首），经 `supplySource` 写回原生——等源态下**补上即当场续播**；
- 队列真的播完（shadow 空）或用户本就暂停：维持旧语义 `seekTo(0)+暂停`；
- 解析失败：60s 冷却并把该条从计划与原生队列撤下（`dropPlanned`，防止原生
  永远等在坏源队头），冷却期满随下一次重推再回来；
- 缓存落盘：`upgradePlanToLocal` 逐曲 `supplySource` 就地换本地文件（窗内条目
  `replaceMediaItem` 替换 URI，不重建列表）——替代旧的 90s 整窗重镜像；
- 计划重推不打扰窗内条目（native 按 mediaId 与窗内去重），切歌/队列增删/
  随机模式切换/待播登记都会重推，成本仅元数据 JSON。

触发链：开播出声、队列变动、每次 transition 簿记后、切后台 5s 兜底、回前台对账后、
needsource 事件。JS 活着时解析都发生在「临播前两三首」，直链过期面从旧窗口
（提前 3 首解析）收窄到队头附近；JS 冻结时靠已补源的 shadow 条目继续推进，
v1.0.12 起更有原生音源引擎兜底（§2.2）。

### 2.2 原生音源引擎（QuickJS 自解析，L4 终局方案）

- **引擎**：`wang.harlon.quickjs:wrapper-android:3.2.0`（预编译 .so，免 NDK/CMake）；
  单线程 context（绑定创建线程即注入，别跨线程），`evaluate/call` 后手动
  `executePendingJobLoop` 排干微任务，自动注入 console + Date。
- **运行时 bundle**：`src/native/nativeRuntimeEntry.ts` 经 `scripts/build-native-runtime.mjs`
  打成 `assets/native-plugin-runtime.js`（≈560KB，`npm run build` 自动产出）：
  插件沙箱与 WebView 同源（`pluginSandboxCore`）+ QuickJS 缺失全局 polyfill +
  定时器走 `__tick` + **同步** `__nativeHttp`（Java OkHttp，宿主线程阻塞）。
  坑：`atob/btoa/Buffer` 必须由 `quickjsPreload.ts` 在**首个 import** 注入——
  依赖（axios/base64 解码）的 `typeof Buffer.from` 求值即 ReferenceError，
  而 QuickJS 没有内置 `atob`。
- **插件同步**：安装/卸载/启停/变量/默认音源变化 → `pluginHost` 钩子 →
  `nativePluginRuntime.ts` 去抖 800ms `syncPlugins`（`sha256(code)` + 源码 + 元数据）
  → 原生落盘 `filesDir/native-plugin-runtime/plugins.json`，冷启动 `ensureReady` 回灌。
- **解析入口**：`PluginRuntime.resolveMediaSource(hash, payload, quality, excludeUrl, timeout)`
  （桥 `PluginRuntimeBridge`），音质阶梯与 `pickSupportedQuality` 与 JS 侧一致；
  返回 `{ok:true, url, headers, userAgent, quality}`——**字段是 `url` 不是 `src`**；
  `musicItem.localPath` 直返 `file://`。
- **服务自驱**：计划条目携带 `payload`（`toPlanPayload` 剥大图的曲目快照，4K 图/32K JSON
  截断）与 `quality`；服务**与 needsource 并行**发起原生解析（2.5s 首发给 JS 先走，
  失败 8s×3 重试，暂停/次数用尽即停，`Log.i` 发起/成功/失败），结果按 `supplySource`
  同语义写回 → 等源态当场续播。JS 先补上则原生结果作废。
- **请求头**：`createPlayer` 用 Media3 `ResolvingDataSource`（1.8.0 **没有**
  `ForwardingDataSource`）按 URI 注入插件返回的 headers（仅原生解析过的地址，≤64 条），
  JS `buildPlayableMediaUrl` 补源路径不变。
- **验证**：`node scripts/test-native-runtime.mjs`（真实 bundle 在 QuickJS 里跑
  axios→原生 HTTP/降档/excludeUrl/定时器/错误透传/增量同步，全绿）；
  模拟器 E2E：CDP `Page.setWebLifecycleState` 冻结页面后，`原生自解析成功：测试音源-2`
  → MediaSession 自动切到下一首继续 PLAYING，解冻后 JS 正常收到 `itemtransition`。

### 2.3 原生坏条目自愈

`onPlayerError`：先 `refillWindow`（shadow 可能刚补上源），队列前方还有歌就
`seekToNextMediaItem + prepare + setPlayWhenReady(true)` 跳过坏条目继续播
（**ERROR 态下 prepare 不继承播放意图，必须显式重申**——模拟器实测踩过）；
身后只剩未解析条目且播放意图还在 → 转等源态（`needsource` 续命）。
连续 5 首全失败才真正停下（翻暂停态）。
JS 侧 `onAudioError` 发现原生已在播就交给对账簿记，避免叠加跳歌。

### 2.4 回前台对账（reconcileWithNative / reconcileAfterForeground）

以 `getState` 的原生现实为准校准 JS：曲目对齐（含收养分支：JS 无源但原生在播）、
播放态对齐、`isLoading` 卡死清理（>45s）、补推计划。`getState` 新增
`awaitingSource/plannedCount`：对账发现原生在等源 → 立即 `supplyPlannedSources`
补源续播。原生 ended 且**计划也耗尽**时 `seekTo(0) + setPlayWhenReady(false)`
翻暂停（通知栏可见地显示已停）。

### 2.5 共播与音频焦点

ExoPlayer **默认不入音频焦点仲裁**（`focusEnabled=false`）：抖音等高频抢焦点
应用不会打断播放。设置页「允许与其他应用同时播放」开 = 不入仲裁（默认）；
关 = 独占（别人开播我们让位）。焦点模式随每次 `loadTrack` 随行重发（服务重建
后恢复用户选择）。非 JS 发起的 pause 一律视为用户意图（通知栏暂停不再被回抢）。
JS 侧共播回抢仅剩 WebView 后端一次静默重试，无巡逻拉锯。

### 2.6 播放缓存（原生直落磁盘）

- 主通道：`Storage.downloadFile`（HttpURLConnection 手动跟随跨协议重定向、
  .part 续传、5 路并发）——**字节不过 JS 桥**，WebView 零参与；
- 回退：blob 过桥路径（Range 分块 256KB/块，共播时块间停 120ms）；
- 静默窗：开播 20s 内不下载（缓冲水位优先）、切后台 8s 内不下载（避开新应用
  冷启动）、窗口条目未落盘时预约 90s 复查入窗；
- 索引在 localStorage（`audioCache.index`），文件在 `cacheDir/audio-cache`。

### 2.7 性能与保活

- 输出缓冲下限 500ms（`DefaultRenderersFactory.buildAudioSink` 覆写
  `setMinPcmBufferDurationUs`）——吸收新应用冷启动的调度尖峰；
- ~~WebView 静音保活 WAV（原生后端在播时启用）+ MainActivity 钉 renderer
  IMPORTANT~~（**已删除**）：实测对 renderer 冻结无效，不再维持这两层。
  后台续播的可靠性完全由原生侧承担——shadow 计划 + needsource 拉取 +
  QuickJS 自解析（§2.1/§2.2），JS 冻结时原生自己把队列推下去；
- `ensureService` 用普通 `startService`（前台服务 5s 超时被杀的教训），
  开播时 Media3 自动晋升前台；**前提是通知权限已授予**——未授予时 Media3 无法
  发前台通知，服务不进 FGS，熄屏约 90s 被系统 `Stopping service due to app idle`
  回收、播放随之停止（模拟器实测：`POST_NOTIFICATIONS: granted=false` 是后台
  连播中途停摆的直接原因）。首次进入播放态会弹一次系统授权框（§四.7），
  用户拒绝则只能在系统设置里补开；
- ExoPlayer 全部访问必须在主线程：插件方法经 `svc.runOnMain` 转投，
  读操作（getState/skip/jumpToItem）转主线程后回填 resolve；
- 进程被杀不再等于停播（v1.0.14）：队列快照 + `onPlaybackResumption` 见 §2.10。

### 2.8 手动点播快路径（`play()` 入口）

用户手动点播的目标若在原生队列计划里**且已解析出源**（`planSources` 带
`playSrc`），直接经 `jumpToItem` 让 ExoPlayer 定点 seek——**不走 loadTrack
重装链路**：loadTrack 会清空当前曲之后的全部条目（通知栏/锁屏「下一首」
图标随之消失，要等异步重推才回来——就是切歌时图标闪一下的根因），而计划里
这首歌的音源早已解析好，跳转即无缝（实测 57ms 完成切换）。目标在 shadow
深处时原生先撤下它之前的计划条目（用户点了这首，中间的被跳过）再入窗定点。
簿记（历史/待播/状态）复用自动续播同一条 `itemtransition` 路径。
未命中/缺源/单曲循环/加载中/重连中一律回退常规换歌链路。

### 2.9 解析泵与换源自愈（v1.0.14）

**解析泵**（`pumpNativeResolve`）：不再「解析队头 → 入窗 → 再解析新队头（又等 2.5s）」，
而是一次把计划前 `NATIVE_RESOLVE_LOOKAHEAD=3` 条缺源条目排上（executor 单线程串行，
不会压垮引擎），深度与窗口量级一致——再深会让直链在计划里躺太久、放大过期面。
重排条件用 `firstResolvablePending()`：只认「缺源 + 不在途 + 有 payload + 次数未用尽」，
次数用尽的条目不再驱动重排（否则无限空转），只等 JS 的 needsource。

**当前曲原地换源**（`retryCurrentTrackNatively`）：
`onPlayerError` 先记「mediaId → 刚失败的直链」，然后优先原地换源而不是直接跳歌——
队列快照恢复出来的队列存的是几小时前的直链，过期概率很高，直接跳歌会把整队
变成「听一首跳一首」。当前曲不在 `pushQueuePlan` 里（那推的是「接下来的」），
payload 经 `loadTrack` 随行下发（JS 侧 `audio.setTrackRecovery(toPlanPayload(target), quality)`），
原生存进 `plannedById` 供换源用。换源成功即 `replaceMediaItem` + `seekTo(原位置)`
+ `prepare` + 重申播放意图（ERROR 态下 prepare 不继承播放意图）；换不出才跳下一首。
重试预算 `MAX_NATIVE_RESOLVE_ATTEMPTS=3`，`loadTrack`/`stop` 时清零。

**excludeUrl 的边界**（踩过的坑）：首次重试把坏直链作 excludeUrl 传给插件换源，
但**从第 2 次起不再排除**——不少插件无视 quality 逐档、只用 musicItem 算出唯一地址，
永远排除会让这条彻底解析不出来（一次网络抖动即永久毒化）。宁可拿回同一条坏源
交给上层自愈跳歌，也不能因为排除而彻底无源。

### 2.10 队列快照与媒体恢复（v1.0.14）

**落盘**（`buildQueueStateJson` → `filesDir/playback-queue.json`）：
存 ExoPlayer 列表（当前曲及身前最多 `KEEP_BEHIND=2` 首）+ shadow 剩余计划 +
当前索引/位置/循环模式/焦点模式。每条带 `payload`/`quality`（来自 `plannedById`，
窗内条目也在其中）——**这是恢复后还能重新解析的依据**。
触发：队列变动（transition / pushQueuePlan / supplySource / dropPlanned / loadTrack）
去抖 1.2s、播放中每 30s、暂停即写、`onDestroy` 兜底。
`stop()` / 用户清空队列 → 快照删除（避免恢复出用户已停止的队列）。

**恢复**（`restoreQueueState`，`onCreate` 时）：
有 src 的进播放器列表，缺源的进 shadow 等补源；**不 prepare、不自动开播**——
进程重启后的出声必须由用户发起，与原生播放器语义一致。
配套：`play()` 补了 IDLE 态判断（恢复出的列表是 IDLE，只 `setPlayWhenReady`
不出声，必须先 `prepare`，否则按播放没反应）。

**系统媒体恢复**（`MediaSession.Callback.onPlaybackResumption`）：
手机重启/进程被杀后，用户从系统媒体卡片点播放时交出队列
（`MediaItemsWithStartPosition`，这条路径需要真正开播）。
`onAddMediaItems` 一并实现：外部控制器（车机/手表）推来的 MediaItem 缺 mediaId 时按 URI 补。

**JS 侧冷启动对账**（`reconcileOnColdStart`）：服务刚被 `startService` 拉起时
`onCreate` 可能没跑完，`getState` 拿到 `available=false`——退避重试 3 次
（0.5s/1s/1.5s），拿到状态后走常规对账（含「JS 无源但原生有」的收养分支）。

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
