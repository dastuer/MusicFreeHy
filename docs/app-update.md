# 应用检查更新

App 内置检查更新功能：启动后自动静默检查（24h 一次）+ 设置页「关于 → 检查更新」手动触发。发现新版本后弹面板展示更新日志，下载 APK（带进度、断点续传），拉起系统安装器完成升级。

## 数据源：Gitee 公开仓库

更新数据全部放在一个 Gitee **公开**仓库里，客户端只做只读 GET，**零 token、零 API 调用**（不走 API 就没有限流问题）：

| 内容 | 存放位置 | 访问方式 |
|---|---|---|
| 版本清单 `update.json` | 仓库根目录 | raw 直链：`https://gitee.com/{owner}/{repo}/raw/master/update.json` |
| 安装包 APK | Release 附件 | 直链：`https://gitee.com/{owner}/{repo}/releases/download/{tag}/{文件名}` |

要点：

- 仓库必须**开源（公开）**；私有仓库 raw 需要认证，用不了
- raw 匿名访问会 302 到 `raw.giteeusercontent.com`，客户端两条网络通道都手动跟随重定向，无需处理
- raw 有服务端缓存（60~300 秒）：发版改完 update.json 后**最多约 5 分钟**全网生效，无缓存可刷
- Release 附件限制：**单文件 ≤ 100MB**、单仓库附件总量 1GB —— APK 在 100MB 内没问题；附件总量满了记得删旧版本附件
- 附件只能**在网页上创建 Release 时上传**（Gitee API 不支持传附件）
- 清单地址写死在 `src/core/appUpdate.ts` 顶部 `UPDATE_MANIFEST_URL` 常量，换仓库时改这一行

## 版本清单 update.json

字段契约（`versionCode` / `versionName` / `apkUrl` 必填，缺失时客户端直接报清单错误）：

```json
{
  "versionCode": 2,
  "versionName": "1.0.1",
  "changelog": "- 修复xxx\n- 新增xxx",
  "apkUrl": "https://gitee.com/{owner}/{repo}/releases/download/v1.0.1/MusicFreeHy-1.0.1.apk",
  "publishedAt": "2026-10-12",
  "minVersionCode": 1
}
```

| 字段 | 说明 |
|---|---|
| `versionCode` | 整数，**更新判断的唯一权威**，每次发版 +1 |
| `versionName` | 展示用语义化版本号（versionCode 相同时客户端会比较它兜底） |
| `changelog` | 更新日志，支持 `\n` 换行 |
| `apkUrl` | Release 附件直链；文件名必须带版本号（客户端按文件名落盘续传） |
| `publishedAt` | 可选，发布日期，面板展示 |
| `minVersionCode` | 可选，强制更新门槛：低于它的本机版本面板不可关闭、无「忽略/稍后」 |

## 首次部署

1. Gitee 建公开仓库（如 `musicfree-hy`，默认分支 master）
2. 提交 `update.json` 到仓库根目录，内容与**当前已分发安装包**一致（`versionCode: 1`、`versionName: "1.0.0"`）——这样部署完即可在旧包里验证「已是最新版本」链路
3. 网页上创建 Release（tag 如 `v1.0.0`），上传当前 APK，附件命名为 `MusicFreeHy-1.0.0.apk`
4. 把 raw 地址填进 `src/core/appUpdate.ts` 的 `UPDATE_MANIFEST_URL`，重新出包
5. 验证：浏览器打开 raw 直链能看到 JSON；App 里点「检查更新」提示「已是最新版本」

## 日常发版

1. 改三处版本号：
   - `android/app/build.gradle`：`versionCode` +1、`versionName` 对应更新
   - `package.json` 与 `src/core/backup.ts` 的 `APP_VERSION`：同步 versionName（展示与备份载荷用）
2. `cd android && ./gradlew assembleRelease` 出签名包（`android/app/build/outputs/apk/release/app-release.apk`；必须同密钥签名，否则用户无法覆盖安装）
3. Gitee 网页创建 Release（tag `v1.0.1`），上传 `MusicFreeHy-1.0.1.apk` 附件
4. 更新仓库里的 `update.json`（网页编辑或 git push）：versionCode +1、changelog、apkUrl 指向新附件直链
5. 旧版用户启动 4s 后收到提示（raw 缓存过期后，最多等约 5 分钟）

## 行为细节

- **忽略此版本**：面板可忽略，静默检查不再提示该 versionCode；手动检查仍会弹出
- **稍后再说**：仅关面板；下载中断的话 `.part` 保留，下次同版本直接续传
- **安装授权**：Android 8+ 首次点「立即安装」会跳「允许安装未知应用」授权页，授权返回后再点一次即装
- **清单错误 / 无网**：自动检查静默失败；手动检查 toast「检查更新失败」
- Gitee 大文件下载速度一般（几百 KB ~ 几 MB/s），面板有进度条与断点续传兜底

## 备选方案

七牛云 Kodo 等对象存储（每月免费额度 + 自定义 CDN 缓存）也可作更新源，客户端代码零差别（只改 `UPDATE_MANIFEST_URL`），但需要实名、备案域名等额外门槛；Gitee 方案零成本开箱即用。
