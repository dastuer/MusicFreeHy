# Android 真机无线调试指南（Windows）

本项目在 Windows 上的 Android 真机调试环境为**精简安装**（无模拟器、无 Android Studio），
全部组件位于 `D:\Android`，通过无线 ADB 连接手机构建、安装与调试。

## 1. 环境组成

| 组件 | 位置 | 说明 |
|---|---|---|
| JDK 21 | `D:\Android\jdk-21.0.12.1+1` | 构建用（Capacitor 8 要求 Java 21），`JAVA_HOME` 已指向此处 |
| JDK 17 | `D:\Android\jdk-17.0.20.1+1` | 备用 |
| cmdline-tools 12.0 | `D:\Android\Sdk\cmdline-tools\latest` | sdkmanager 等 |
| platform-tools 37 | `D:\Android\Sdk\platform-tools` | adb、fastboot，已加入用户 PATH |
| platforms;android-36 | `D:\Android\Sdk\platforms\android-36` | compileSdk 36 |
| build-tools;35.0.0 | `D:\Android\Sdk\build-tools\35.0.0` | AGP 8.13 默认版本（必须） |
| build-tools;36.0.0 | `D:\Android\Sdk\build-tools\36.0.0` | 备用 |

已配置：用户环境变量 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `JAVA_HOME`，
项目文件 [android/local.properties](../android/local.properties)（`sdk.dir`）、SDK 许可证预接受。

> JDK 来源：清华 Adoptium 镜像；SDK 组件来源：腾讯镜像
> `https://mirrors.cloud.tencent.com/AndroidSDK/`（`dl.google.com` 在本机网络不可达）。

## 2. 日常流程（改代码 → 装到手机）

在 PowerShell 中于项目根目录执行：

```powershell
# 1. 构建 Web 资源并同步到 Android 工程
npm run build; npx cap sync android

# 2. 编译 Debug APK
cd android; .\gradlew.bat assembleDebug; cd ..

# 3. 安装并启动
D:\Android\Sdk\platform-tools\adb.exe install -r android\app\build\outputs\apk\debug\app-debug.apk
D:\Android\Sdk\platform-tools\adb.exe shell am start -n com.huah.musicfree.hy/.MainActivity
```

注意：`npm run android:run` 是 zsh 脚本（macOS 用），Windows 下用上面三条命令代替。

## 3. 无线 ADB 连接

### 首次配对（每台手机只需一次）

1. 手机与电脑连**同一 Wi-Fi**
2. 手机：设置 → 开发者选项 → 打开「无线调试」
3. 点进「无线调试」→「使用配对码配对设备」，记下屏幕上的
   **配对 IP:端口**（如 `192.168.124.2:37087`）和 **6 位配对码**（2 分钟内有效）
4. 电脑执行：

   ```powershell
   adb pair 192.168.124.2:37087 641774   # 换成屏幕显示的端口和配对码
   ```

### 之后每次连接

手机「无线调试」主页显示 **IP 地址和端口**（与配对端口不同）：

```powershell
adb connect 192.168.124.2:42241   # 换成当前显示的端口
adb devices                        # 确认状态为 device
```

- 手机端开关一次「无线调试」，端口就会变化，需重新 `adb connect`
- 配对关系保留，无需再次输配对码
- 手机息屏断开 Wi-Fi 后连接会掉，重新 connect 即可

## 4. 调试手段

### WebView 调试（chrome://inspect）

Debug 包默认开启 WebView 调试。手机打开 App 后，电脑 Chrome 访问 `chrome://inspect`，
在设备列表中点击对应页面的 **inspect**，即可用 DevTools 调试 WebView 内的前端页面
（Console、Network、Elements 与普通网页一致）。

> Network 面板抓的是 WebView 请求，媒体流与插件 API 请求都能看到。

### logcat 日志

```powershell
# 全量日志按关键字过滤
adb logcat | Select-String "capacitor|chromium|Console"

# 按进程过滤（更干净）
$pid = (adb shell pidof -s com.huah.musicfree.hy).Trim()
adb logcat --pid=$pid
```

### 局域网浏览器调试（不装 APK，改代码即时热更）

```powershell
npm run dev   # vite 已配置 host: true，端口 5175
```

手机浏览器访问 `http://<电脑IP>:5175`（本机为 `http://192.168.124.3:5175`）。
插件请求代理已在 dev server 同源挂载，一般无需单独起 `npm run proxy`。

## 5. 常见问题

### INSTALL_FAILED_UPDATE_INCOMPATIBLE（签名不匹配）

旧版 App 由其他密钥签名时，覆盖安装会失败，需先卸载（**会清空 App 本地数据**）：

```powershell
adb uninstall com.huah.musicfree.hy
adb install android\app\build\outputs\apk\debug\app-debug.apk
```

卸载前如需保留数据，先在 App 内做 WebDAV/文件备份，装好后恢复。

### 构建长时间卡在 "Still waiting for package manifests to be fetched remotely"

AGP 内置 SDK 管理器硬编码访问 `dl.google.com`，本机网络下 TCP 被静默丢弃导致无限挂起。
已在 [android/gradle.properties](../android/gradle.properties) 配置 fail-fast 代理
（`127.0.0.1:1`，镜像域名白名单直连）使其秒级失败，切勿删除该配置。

### 构建报 "Could not download gradle-x.jar (dl.google.com)"

仓库镜像不完整所致。当前 [android/build.gradle](../android/build.gradle) 的
`buildscript`、`allprojects` 与 [android/settings.gradle](../android/settings.gradle)
的 `pluginManagement` 均**只保留阿里云镜像**（阿里云 google/central/gradle-plugin 为完整
代理，无需官方源兜底），不要把 `google()` / `mavenCentral()` 加回去。

### Gradle 发行版下载慢/失败

[android/gradle/wrapper/gradle-wrapper.properties](../android/gradle/wrapper/gradle-wrapper.properties)
已指向腾讯镜像，且 `networkTimeout` 已放大到 120s。

### 报错 "Cannot find a Java installation ... languageVersion=21"

Capacitor 8 子模块要求 Java 21 工具链。确认 `JAVA_HOME` 指向
`D:\Android\jdk-21.0.12.1+1`，并先 `gradlew.bat --stop` 停掉旧 daemon 再构建。

### 构建报缺少某 build-tools 版本

AGP 默认 build-tools 与 AGP 版本绑定（AGP 8.13 → 35.0.0）。缺哪个就从腾讯镜像下哪个，
解压后把解出的顶层目录移到 `D:\Android\Sdk\build-tools\<版本号>`：

```powershell
curl.exe -L -o D:\Android\downloads\bt.zip https://mirrors.cloud.tencent.com/AndroidSDK/build-tools_r35_windows.zip
Expand-Archive D:\Android\downloads\bt.zip D:\Android\temp
Move-Item D:\Android\temp\* D:\Android\Sdk\build-tools\35.0.0   # 顶层目录名可能是 android-15 等代号
```
