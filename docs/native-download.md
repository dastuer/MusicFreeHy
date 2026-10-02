# 原生直落磁盘下载（终极方案）

> 目标：把「HTTP 拉流 + 写盘」整体下沉到原生线程，进度走 Capacitor 事件回传（小 JSON），
> 下载数据**完全不过 JS 桥**，真机 5 并发下载期间 JS 主线程零阻塞，App 全程流畅。

## 1. 背景

下载现状（`src/core/musicDownload.ts`）：原生端通过 CapacitorHttp 发分块 Range 请求
（`nativeChunkedDownload`），每个 512KB 分块以 base64 过桥，在 **JS 主线程同步**做桥接消息
JSON 解析 + base64 解码（约 8-15ms/块）。该成本与并发数成正比：

- 串行下载（1 路）≈ 400-800ms/s 主线程占用 —— 轻微卡顿
- 5 并发（5 路）≈ 2000-4000ms/s —— **主线程被打满，整个 App（含播放器）卡顿**

已上线的缓解措施（治标，需保留作为回退路径）：

| 措施 | 位置 |
|---|---|
| 全局过桥令牌桶 `acquireBridgeToken`（16 块/s ≈ 8MB/s 聚合，后台放开） | musicDownload.ts |
| 分块间让出主线程 `yieldToMainIfVisible`（后台跳过） | musicDownload.ts / native.ts |
| 进度 patch 节流 400ms | musicDownload.ts `runTask` |
| 任务落盘节流（结构变化立即写、进度 1s 合并写） | musicDownload.ts `schedulePersistTasks` |
| 渲染分层（页面订阅结构视图、任务行自订阅进度） | musicDownload.ts / MusicList.tsx |
| 写盘分块 `WRITE_CHUNK`≈1MB + 块间让渡 | native.ts |

这些只能把占用压到 ~20%，**数据过桥的固有成本无法消除**。终极方案是让字节根本不进 JS。

## 2. 现状代码地图（动手前先读）

| 位置 | 内容 |
|---|---|
| `src/core/musicDownload.ts` | 下载队列核心：`downloadTasksAtom`（含 addedAt/addedSeq）、`pumpQueue`（5 并发调度）、`runTask`（resolveMediaUrl → fetchBlob → saveBlob → markDownloaded）、`fetchBlob`（native 走 nativeChunkedDownload，web 走 fetch 流式，失败回退伴生代理 /media）、`nativeChunkedDownload`（Range 分块 + 过桥）、`saveBlob`（android → writeAndroidFile；ios → writeIosFile；浏览器 → `<a download>`；失败回退 system）、暂停/停止 = AbortController → AbortError → paused、`acquireBridgeToken` 令牌桶 |
| `src/core/native.ts` | `callNativeMethod(plugin, method, options)`（`Cap.nativePromise`，插件/方法缺失会抛错）、`writeAndroidFile` / `writeIosFile`（分块 base64 过桥写盘）、`WRITE_CHUNK`、`yieldToMainIfVisible`、`hasNativeHttp()` |
| `android/app/src/main/java/com/huah/musicfree/hy/StoragePlugin.java` | 自定义 Capacitor 插件（351 行，`extends Plugin`），现有 `@PluginMethod`：`writeFile`（分块追加写）、`deleteFile`、`requestWritePermission`（「所有文件访问」门禁）等 |
| `android/.../LocalMusicPlugin.java` | `getDefaultDirs` 返回 documents / filesDir 等 |
| `android/.../MediaPlaybackService.java` / `MediaNotificationPlugin.java` | 已有后台 Service 与媒体通知先例（可参考前台服务/事件回传写法） |
| `ios/App/App/` | **无自定义 Swift 插件**（仅默认 AppDelegate/SceneDelegate/ViewController），iOS 写盘用 `@capacitor/filesystem`（DATA / DOCUMENTS） |
| 语义约定 | 记录 `{ item, quality, path, size, downloadedAt, addedAt, addedSeq, location }`；location ∈ system/documents/data/external；删除记录会 `deleteFile` 删源文件；同名覆盖 |

## 3. 设计

### 3.1 Android：`StoragePlugin` 新增 `downloadFile` / `cancelDownload`

```
@PluginMethod downloadFile(call)
  参数: { taskId: String, url: String, headers: Map<String,String>, destPath: String }
  行为:
    - OkHttp 异步请求（Capacitor 自带 okhttp 依赖），流式写 destPath + ".part"
      （输出流 append 模式；.part 不存在则新建）
    - 续传: .part 已存在时发 `Range: bytes=<partSize>-`；响应 206 → 追加；
      响应 200（服务器不支持 Range）→ 丢弃 .part 重下整包
    - 进度: 每 ~200ms 或每 1% 变化 notifyListeners("downloadProgress",
      { taskId, loaded, total })  —— 小 JSON，不构成桥接压力
    - 成功: .part 原子重命名为 destPath，call.resolve({ path, size })
    - 失败: call.reject(message)，.part 保留供续传
    - 中断: 原生侧保存 taskId → Call/ResponseBody 的映射，供 cancelDownload 中断

@PluginMethod cancelDownload(call)
  参数: { taskId }
  行为: 中断该 taskId 的 OkHttp 调用（call.cancel()），关闭流，保留 .part，
        call.resolve({ cancelled: true })；找不到 taskId 也 resolve（幂等）
```

注意：
- 写公共目录沿用现有 `requestWritePermission` 的「所有文件访问」门禁（调用方在 JS 侧已处理，downloadFile 前照常先请求）。
- 5 路并发 = 5 个 OkHttp 异步调用，原生线程池自然承载，无桥接成本。
- 需要处理磁盘 IO 异常 / HTTP 4xx/5xx / 连接超时（建议 connect 20s / read 60s，与现状一致）。

### 3.2 iOS：新增自定义 Swift 插件

- 新文件 `ios/App/App/DownloadPlugin.swift`（`@objc(DownloadPlugin)` extends `CAPPlugin`）：
  - `downloadFile(taskId, url, headers, destPath)`：`URLSession` downloadTask（或 dataTask 流式写盘），
    `URLSessionDownloadDelegate` 回传进度 → `notifyListeners("downloadProgress", ...)`，节流同 Android。
  - 续传：优先 `resumeData`（内存中保存 taskId → resumeData；App 被杀则放弃续传整包重下）；
    也可用 Range + 流式追加实现，二选一，语义与 Android 对齐。
  - `cancelDownload(taskId)`：`task.cancel()`，保留已写字节。
  - destPath 目录解析沿用现有 location 语义（documents → `NSSearchPathForDirectoriesInDomains`）。
- 插件注册：**按 Capacitor 8 官方文档 "Custom Code > iOS" 核实注册方式**并落地
  （App 工程内 Swift 插件需在注册清单中声明；实施者以 docs.capacitorjs.net 当前版本说明为准）。
- 头文件桥接：Swift 暴露给 Capacitor 需要 `@objc` 与必要的 Bridging/目录配置，构建时报错按提示处理。

### 3.3 TS 侧改造

`src/core/native.ts` 新增：

```ts
/** 原生直落磁盘下载：监听 downloadProgress 事件按 taskId 过滤，resolve 最终 { path, size }。
 *  onProgress 仅透传 (loaded, total)，节流由调用方处理（现有 400ms patchTask 节流沿用） */
export function nativeDownloadFile(
    taskId: string,
    url: string,
    headers: Record<string, string>,
    destPath: string,
    onProgress?: (loaded: number, total: number) => void,
): Promise<{ path: string; size: number }>;

/** 中断原生下载（保留 .part），幂等 */
export function nativeCancelDownload(taskId: string): Promise<void>;
```

实现要点：`Cap.addListener("downloadProgress", cb)` 按 `taskId` 过滤；promise resolve/reject 后
移除监听；`callNativeMethod("Storage", "downloadFile", ...)`（iOS 用对应插件名）。

`src/core/musicDownload.ts` 的 `runTask` 原生分支重构：

1. `resolveMediaUrl` 拿 url / headers（不变）。
2. 目标路径计算沿用 `saveBlob` 的 android/ios 分支逻辑（目录 + 文件名），改为把
   `destPath` 传给 `nativeDownloadFile`；公共目录权限请求照旧。
3. `onProgress` → 现有 400ms 节流 `patchTask({ progress })`。
4. 完成 → 直接 `markDownloaded({ path, size, location, addedAt, addedSeq ... })`，
   **JS 层全程不出现 blob**（不再 writeAndroidFile）。
5. `AbortController` 触发（暂停/停止）→ 调 `nativeCancelDownload`；catch 分支与现状一致（paused/error）。
6. **回退链**：原生方法不存在（老 App 版本）或调用抛错 → 退回现有
   `nativeChunkedDownload + writeAndroidFile` 路径（含令牌桶限流 + 让渡）；
   浏览器（非 isNative）路径完全不变。
7. `nativeChunkedDownload` / `acquireBridgeToken` / `writeAndroidFile` 等**保留不删**（fallback +
   播放缓存等其他功能仍在用 writeAndroidFile）。

### 3.4 生命周期与清理语义

- **暂停** = cancelDownload 保留 `.part`；**继续** = 重新 `downloadFile` 同 destPath 续传
  （progress 展示可从 0 重算，已下载字节不重复传输）。
- **停止 / 清除失败 / 删除下载记录**：现有逻辑外，尽力删除对应 `.part` 残留
  （`.part` 命名规则：`destPath + ".part"`，删除时按此拼接）。
- App 冷启动后（resumeData 丢失）：`.part` 仍在 → Android 直接 Range 续传，iOS 无 resumeData
  时整包重下（清掉旧 `.part`）。
- 下载成功后旧 `.part` 不存在（已 rename）。

## 4. 验收标准

1. 真机 5 并发下载 30MB×5：滑动列表、切页、播放控制与空闲状态**主观无差异**。
2. 进度条 / 右侧百分比正常更新（每秒 2-5 次）。
3. 暂停 → `.part` 保留；继续 → 续传生效（抓包或日志确认未重复下载已完成字节）。
4. 停止 / 失败重试 / 清除失败行为与现状一致；清除后无 `.part` 残留。
5. 下载记录 path/size/location 语义与现状一致；删除记录能删到源文件（现有 deleteFile 逻辑复用）。
6. 非 Range 服务器整包下载成功。
7. 回归：浏览器（`npm run dev`）下载路径不受影响；老版本插件缺失时回退路径可用。
8. 构建：`npm run build`（含 tsc）通过；Android `cd android && ./gradlew assembleDebug` 编译通过；
   iOS 有条件则 xcodebuild 验证。

## 5. 实施顺序建议

1. Android `downloadFile`/`cancelDownload` + JS 封装 + runTask 接入 + 回退链（先跑通主链路）。
2. 真机验证卡顿消除与验收 1-6。
3. iOS Swift 插件对齐（独立提交）。
4. 清理语义补全（.part 删除）与回归。

## 6. 风险与备注

- iOS 插件注册方式以 Capacitor 8 当前官方文档为准，不要照抄旧版本宏。
- 续传依赖服务端 Range 支持；不支持时整包重下（可接受）。
- 令牌桶限流仅作用于回退路径；直落磁盘后原生并发不再受限流影响。
- 不要引入新依赖（OkHttp 由 Capacitor 传递依赖提供；iOS 用系统 URLSession）。
- 仓库代码风格：中文注释、四空格缩进、JSDoc 标注导出项。
