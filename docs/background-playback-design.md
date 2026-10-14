# 后台播放设计与实现现状（截至 v1.0.11）

> 本文是后台播放子系统的**当前真实状态**与历史决策记录，供后续优化接续。
> 演进脉络：v1.0.7 全原生播放内核重构 → v1.0.8~1.0.10 后台连播多轮修复 →
> v1.0.11 预载收敛为「只预载下一首」。主要提交：`ae0abc3`（内核重构）、
> `3a150ab`（修崩溃）、`fb13dfa`/`b57a84b`/`626fd0f`（卡顿三层优化）、
> `0c44bc5`（共播）、`f83bc9b`（通知暂停）、`ff7ba9f`/`31d4881`（窗口本地化与分层）、
> `89aae3f`+`c44f54c`（删预载又还原，最终保留）、`af16279`（窗口 6→2）。

## 一、架构总览

```
WebView JS（前台）：音源解析（插件 getMediaSource）、队列语义、历史、UI、缓存下载调度
   │ PlaybackBridge 桥
   ▼
MediaPlaybackService（Media3 MediaSessionService 前台服务，Android 原生）
   ├─ ExoPlayer：OkHttp 数据源 / 30~60s 大缓冲 / WAKE_MODE_NETWORK / 输出缓冲≥500ms
   ├─ MediaSession：通知栏、耳机、蓝牙、锁屏（系统渲染，不经 JS）
   └─ 播放列表：[已播≤2 首] + [当前] + [预载窗口≤2 首]
```

关键文件：
- `android/.../MediaPlaybackService.java` — 播放内核（队列/自愈/通知/焦点）
- `android/.../PlaybackBridge.java` — JS↔服务桥 + 电池优化 + 共播查询
- `src/core/trackPlayer.ts` — 播放语义/窗口镜像/对账/失败自救
- `src/core/nativeAudio.ts` — HTMLAudioElement 同形 facade
- `src/core/audioCache.ts` — 播放缓存（原生直落磁盘主通道）

## 二、核心机制（当前生效）

### 2.1 队列窗口镜像（预载，窗口=2）

一首歌开播后，JS 解析**接下来 1 首**（`QUEUE_WINDOW_SIZE=2` = 当前+下一首，
`QUEUE_WINDOW_MAX=2` 原生同值），连同元数据经 `pushQueueWindow` 推进原生
播放列表。触发点：开播出声、切后台 5s 后兜底、每次 transition 簿记后、回前台
对账后。原生播完当前曲自动无缝续播预载曲，JS 只在 `itemtransition` 事件里做簿记。

**取源分层**（v1.0.10 定稿）：窗口第 1 首缓存命中用本地文件、未命中推直链
（刚解析的直链几十分钟内有效，保证窗口非空、下一首永远可播）；启动缓存下载，
落盘回调（`setCacheStoredListener`）与 90s 复查把本地路径换进窗口。
**推空窗口保护**：upcoming 有歌但全部未就绪时保留旧窗口，绝不推空。

### 2.2 原生坏条目自愈

`onPlayerError`：队列前方还有歌就 `seekToNextMediaItem + prepare +
setPlayWhenReady(true)` 跳过坏条目继续播（**ERROR 态下 prepare 不继承播放
意图，必须显式重申**——模拟器实测踩过）。连续 5 首全失败才真正停下（翻暂停态）。
JS 侧 `onAudioError` 发现原生已在播就交给对账簿记，避免叠加跳歌。

### 2.3 回前台对账（reconcileWithNative / reconcileAfterForeground）

以 `getState` 的原生现实为准校准 JS：曲目对齐（含收养分支：JS 无源但原生在播）、
播放态对齐、`isLoading` 卡死清理（>45s）、补镜像。原生 ended 且队列耗尽时
`seekTo(0) + setPlayWhenReady(false)` 翻暂停（通知栏可见地显示已停）。

### 2.4 共播与音频焦点

ExoPlayer **默认不入音频焦点仲裁**（`focusEnabled=false`）：抖音等高频抢焦点
应用不会打断播放。设置页「允许与其他应用同时播放」开 = 不入仲裁（默认）；
关 = 独占（别人开播我们让位）。焦点模式随每次 `loadTrack` 随行重发（服务重建
后恢复用户选择）。非 JS 发起的 pause 一律视为用户意图（通知栏暂停不再被回抢）。
JS 侧共播回抢仅剩 WebView 后端一次静默重试，无巡逻拉锯。

### 2.5 播放缓存（原生直落磁盘）

- 主通道：`Storage.downloadFile`（HttpURLConnection 手动跟随跨协议重定向、
  .part 续传、5 路并发）——**字节不过 JS 桥**，WebView 零参与；
- 回退：blob 过桥路径（Range 分块 256KB/块，共播时块间停 120ms）；
- 静默窗：开播 20s 内不下载（缓冲水位优先）、切后台 8s 内不下载（避开新应用
  冷启动）、窗口条目未落盘时预约 90s 复查入窗；
- 索引在 localStorage（`audioCache.index`），文件在 `cacheDir/audio-cache`。

### 2.6 性能与保活

- 输出缓冲下限 500ms（`DefaultRenderersFactory.buildAudioSink` 覆写
  `setMinPcmBufferDurationUs`）——吸收新应用冷启动的调度尖峰；
- WebView 静音保活 WAV（原生后端在播时启用）+ MainActivity 钉 renderer
  IMPORTANT——维持 JS 存活以补窗口（部分 ROM 无视钉优先级，这是纵深不是保证）；
- `ensureService` 用普通 `startService`（前台服务 5s 超时被杀的教训），
  开播时 Media3 自动晋升前台；
- ExoPlayer 全部访问必须在主线程：插件方法经 `svc.runOnMain` 转投，
  读操作（getState/skip）转主线程后回填 resolve。

## 三、桥接协议备忘

| 方法 | 说明 |
|------|------|
| loadTrack(src,mediaId,startMs,autoplay,title,artist,album,artworkUri) | 装载当前曲（替换整条列表）；焦点模式随行重发 |
| pushQueueWindow(items≤2) | 替换「当前曲之后」的预载位（元数据随条目） |
| play/pause/stop/seekTo/setRate/setVolume/setRepeatMode/setAudioFocusMode | 直达播放器 |
| skip(direction) | 原生队列直切，返回切到的 mediaId（空=无目标） |
| getState | currentMediaId/currentSrc/positionMs/bufferedMs/durationMs/paused/ended/playing/hasNext/rate/volume |
| otherMediaPlaying | 活跃媒体会话数（排除自家），缓存下载共播让路用 |

事件（audioEvent）：play/pause/playing/ended/error(detail 可带 `|skip`)/
timeupdate(每 1s 带数值载荷)/durationchange/itemtransition(mediaId,index)。

## 四、已知边界与遗留问题（新窗口的优化空间）

1. **后台连播上限 = 1 首**（窗口=2 的直接代价）：播完下一首即停，等 JS 复活
   补窗。如放宽改 `QUEUE_WINDOW_SIZE`/`QUEUE_WINDOW_MAX`（两处同值）即可，
   但窗口越大、未本地化条目越多，直链过期风险越高（v1.0.9 教训：全本地化又
   会导致窗口经常为空反而更糟——平衡点在第 1 首直链兜底 + 其余本地）。
2. **直链时效 vs 本地化进度赛跑**：缓存下载慢于播放推进时，窗口仍是直链；
   冻结期间无法重推。可考虑：缓存落盘即推「替换窗口条目」（现在只整窗重镜像）。
3. **原生侧无预解析能力**：音源解析被锁死在 WebView 插件机制里，是所有
   「JS 死了怎么办」问题的总根源。长期方向是把常用音源平台的原生解析下沉
   （工作量大，需评估）。
4. **Web MediaSession 与原生通知并存**：Android 上 `updateMediaSession` 仍写
   navigator.mediaSession（无实际渲染方），可裁剪。
5. **`computeUpcoming` 与 `computeNextMusicItem`/`getNextIndex` 取歌语义三处
   相似实现**，随机模式一致性靠约定，值得合并成单一来源。
6. **验证缺口**：长时间后台（>窗口总时长）回对账、弱网断流自救，只有模拟器
   局部验证，缺真机长时回归。

## 五、验证方式速查

- 无线调试：手机开「开发者选项→无线调试」→ `npm run android:connect`（mDNS
  失效时扫端口：`nc -z 192.168.1.3 <port>` 批量探）；
- WebView 注入调试：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`
  后用 DevTools 协议 `Runtime.evaluate` 直调 `Capacitor.nativePromise`；
- 模拟器：AVD `MusicFree-Pixel7`；本地测试音源 `python3 -m http.server 18080`
  （模拟器内地址 `10.0.2.2:18080`）；坏链用 `https://httpstat.us/404`；
- 崩溃：`adb logcat -b crash`；npm 用 nvm 的（pyenv shim 的 npm 坏）：
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`；
- 发版：`node scripts/release.mjs <版本> --notes "..."`（需 GITEE_TOKEN，在 ~/.zshrc）。
