#!/bin/zsh
# MusicFreeHy iOS 真机调试一键脚本：构建 Web → 同步 → 编译 → 安装 → 启动
# 用法：./scripts/ios-run.sh [设备UDID]
set -e

DEVICE="${1:-00008027-000D58E11184002E}"   # huah 的 iPad Pro 11-inch
BUNDLE_ID="com.huah.musicfree.hy"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$HOME/Library/Developer/Xcode/DerivedData/App-cswtfcidxtzeoogyoomfcvxygjft/Build/Products/Debug-iphoneos/App.app"
TEAM_ID="W6L82BPQT7"

cd "$PROJECT_ROOT"

echo "▸ 1/4 构建 Web 资源"
npm run build

echo "▸ 2/4 同步到 iOS 工程"
npx cap sync ios

echo "▸ 3/4 编译（真机 $DEVICE）"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$DEVICE" \
  DEVELOPMENT_TEAM=$TEAM_ID CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates build 2>&1 | tail -3

echo "▸ 4/4 安装并启动"
xcrun devicectl device install app --device "$DEVICE" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"

echo "✅ 已在设备上启动。查看 WebView 调试：Safari → 开发 → 你的 iPad → localhost"
