#!/bin/zsh
# MusicFreeHy Android 真机调试一键脚本：检查设备 → 构建 Web → 同步 → 编译 → 安装 → 启动
# 用法：./scripts/android-run.sh [-l] [设备序列号]
#   -l            启动后跟踪应用日志（Ctrl+C 退出）
#   设备序列号    多台设备时指定，单台可省略；无线调试先 adb connect <ip:端口>
set -e -o pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ID="com.huah.musicfree.hy"
MAIN_ACTIVITY="$APP_ID/.MainActivity"
APK="android/app/build/outputs/apk/debug/app-debug.apk"

LOG=0
DEVICE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -l) LOG=1 ;;
        *) DEVICE="$1" ;;
    esac
    shift
done
ADB="adb"
[[ -n "$DEVICE" ]] && ADB="adb -s $DEVICE"

cd "$PROJECT_ROOT"

echo "▸ 1/5 检查设备"
if ! $ADB get-state >/dev/null 2>&1; then
    echo "❌ 未检测到安卓设备。请："
    echo "   - 插上 USB 并开启「USB 调试」（多台设备时传入序列号：$0 -l <序列号>）"
    echo "   - 或无线调试：先 adb connect <ip:端口>"
    adb devices
    exit 1
fi
$ADB devices

echo "▸ 2/5 构建 Web 资源"
npm run build

echo "▸ 3/5 同步到 Android 工程"
npx cap sync android

echo "▸ 4/5 编译 Debug APK（-q 静默，仅输出告警与错误）"
(cd android && ./gradlew assembleDebug -q --console=plain)

echo "▸ 5/5 安装并启动"
$ADB install -r "$APK"
$ADB shell am force-stop "$APP_ID"
$ADB shell am start -n "$MAIN_ACTIVITY"

PID=$($ADB shell pidof -s "$APP_ID" | tr -d '[:space:]')
echo "✅ 已在设备上启动（pid $PID）。"
echo "   - WebView 调试：Chrome 打开 chrome://inspect（Debug 包默认开启）"
if [[ $LOG -eq 1 ]]; then
    echo "▸ 跟踪日志（Ctrl+C 退出）"
    $ADB logcat --pid="$PID" 2>/dev/null || $ADB logcat
fi
