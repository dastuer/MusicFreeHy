# Android 模拟器调试指南（macOS，调试首选）

日常调试**优先使用本地安卓模拟器**：随叫随到、不受手机电量/息屏/无线断连影响，
arm64 镜像在 Apple Silicon 上流畅度接近真机。真机（无线 ADB，见
[android-remote-debug.md](android-remote-debug.md)）只用于最终验证——后台保活、
厂商省电策略、音频焦点等模拟器覆盖不到的行为。

## 1. 本机环境（已配置完成）

| 组件 | 位置 | 说明 |
|---|---|---|
| Android Studio | `/Applications/Android Studio.app` | IDE，原生层断点调试用 |
| SDK | `~/Library/Android/sdk` | 含 platform-tools（adb）、emulator |
| 系统镜像 | `system-images/android-36/google_apis/arm64-v8a` | Android 16（API 36），arm64 |
| AVD | `MusicFree-Pixel7`（Pixel 7） | 用 `avdmanager` 创建 |

> 镜像来源：腾讯云镜像 `https://mirrors.cloud.tencent.com/AndroidSDK/sys-img/google_apis/`
> （官方 `dl.google.com` 直连太慢）。sdkmanager 不支持注入镜像 URL，需要手动下载 zip
> 解压到 `~/Library/Android/sdk/system-images/<api>/<tag>/` 下即可被识别：
>
> ```bash
> curl -L -o /tmp/sysimg.zip \
>   https://mirrors.cloud.tencent.com/AndroidSDK/sys-img/google_apis/arm64-v8a-36_r07.zip
> mkdir -p ~/Library/Android/sdk/system-images/android-36/google_apis
> unzip -q /tmp/sysimg.zip -d /tmp/sysimg-extract
> mv /tmp/sysimg-extract/arm64-v8a ~/Library/Android/sdk/system-images/android-36/google_apis/
> ```
>
> 新建 AVD：
>
> ```bash
> ~/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager create avd \
>   -n MusicFree-Pixel7 -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
> ```

## 2. 启动模拟器

```bash
~/Library/Android/sdk/emulator/emulator -list-avds    # 查看已有 AVD
~/Library/Android/sdk/emulator/emulator -avd MusicFree-Pixel7 -gpu host &
~/Library/Android/sdk/platform-tools/adb devices      # 出现 emulator-5554 device 即就绪
```

或直接在 Android Studio → Device Manager 里点 ▶。首次冷启动约 1–2 分钟，之后走
快照快速启动会快很多。等待开机完成的可靠判据：

```bash
adb -s emulator-5554 shell getprop sys.boot_completed   # 输出 1
```

## 3. 装应用到模拟器

```bash
npm run cap:sync      # 构建前端 + 同步进 android/ 工程
npm run android:run   # 编译 APK → 安装 → 启动 → 转发 devtools 端口
```

`scripts/device.mjs` 在同时连接了模拟器和真机时**自动选择模拟器**（`emulator-*` 优先）。

也可以手动三步（注意 `-s emulator-5554` 指定设备）：

```bash
cd android && ANDROID_HOME=~/Library/Android/sdk ./gradlew :app:assembleDebug
~/Library/Android/sdk/platform-tools/adb -s emulator-5554 install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
~/Library/Android/sdk/platform-tools/adb -s emulator-5554 shell am start \
  -n com.huah.musicfree.hy/.MainActivity
```

> **不要用 `./gradlew installDebug`**：它会安装到所有已连接设备，真机上装着
> release 签名的正式包，与 debug 包签名不同，会报
> `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 导致整个任务失败。assembleDebug +
> `adb -s <serial> install` 才能精确投递到模拟器。

## 4. 热重载调试

```bash
npm run android:live
```

模拟器里的 App 会加载 Mac 上 vite 开发服务器（`http://<本机IP>:5175`），改 `src/`
即时生效、无需重新打包；Ctrl+C 退出并还原打包配置。原生代码或插件清单变更后仍需
重跑 `npm run android:run`。

## 5. 调试手段

- **前端（WebView）**：Chrome 打开 `chrome://inspect` → 对应页面点 Inspect
  （`android:run` / `android:live` 已自动转发 `tcp:9222`，也可直接访问
  `http://localhost:9222` 看可检查目标）。Console / Network / 断点与普通网页一致。
- **原生日志**：`npm run android:log`（按 pid 过滤 Capacitor/Console/chromium）。
- **原生断点**：`npm run cap:android` 用 Android Studio 打开工程，Run/Debug 选
  emulator-5554，可在 `MediaPlaybackService`、`PlaybackBridge` 等 Kotlin/Java 代码打断点。

## 6. 模拟器调试的注意事项

- **后台行为与真机有差异**：模拟器电源常亮、不模拟厂商省电冻结。调「后台播放/切歌」
  这类问题时，先在模拟器验证逻辑正确性，最终结论以真机为准。
- **测试音源**：模拟器访问 Mac 的局域网 IP 即可（如安装 `http://<本机IP>:5175/mock-plugin.js`）；
  若走 localhost 需 `adb -s emulator-5554 reverse tcp:5175 tcp:5175`。
- **性能**：Apple Silicon 必须用 arm64-v8a 镜像（x86_64 镜像靠转译，极慢且 WebView 行为异常）。
- **磁盘**：AVD 数据在 `~/.android/avd/MusicFree-Pixel7.avd/`，`emulator -avd ... -wipe-data`
  可重置为出厂状态（调试数据污染时用）。
