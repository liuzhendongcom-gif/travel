#!/bin/bash
set -e

APP="/Users/liuzhendong/travel-reimbursement/dist/release-1.3.0/mac-arm64/差旅报销助手1.3.app"
SCRIPT_FILE="/Users/liuzhendong/travel-reimbursement/assets/一键修复Mac安全拦截.command"
BG_TIFF="/Users/liuzhendong/travel-reimbursement/assets/dmg-background.tiff"
OUT_DMG="/Users/liuzhendong/travel-reimbursement/dist/release-1.3.0/差旅报销助手1.3-1.3.0-arm64.dmg"
STAGE="/tmp/dmg-stage-$$"
TEMP_DMG="/tmp/temp-$$.dmg"
VOL_NAME="差旅报销助手1.3"

echo "→ 准备目录..."
rm -rf "$STAGE"
mkdir -p "$STAGE/.background"
cp -a "$APP" "$STAGE/"
cp "$SCRIPT_FILE" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp "$BG_TIFF" "$STAGE/.background/dmg-background.tiff"

echo "→ 创建可读写 HFS+ DMG..."
STAGE_SIZE=$(du -sm "$STAGE" | awk '{print $1}')
DMG_SIZE=$((STAGE_SIZE + 30))
hdiutil create -srcfolder "$STAGE" -volname "$VOL_NAME" \
  -fs HFS+ -fsargs "-c c=64,a=16,e=16" \
  -format UDRW -size ${DMG_SIZE}m "$TEMP_DMG"

echo "→ 挂载..."
DEV=$(hdiutil attach -readwrite -noverify -noautoopen "$TEMP_DMG" | grep Apple_HFS | awk '{print $1}')
VOL_PATH="/Volumes/$VOL_NAME"
sleep 3

echo "→ AppleScript 设置布局和背景..."
osascript << APPLESCRIPT
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {400, 100, 940, 600}
    set theViewOptions to icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 80
    set background picture of theViewOptions to file ".background:dmg-background.tiff"
    set position of item "差旅报销助手1.3.app" to {130, 120}
    set position of item "Applications" to {410, 120}
    set position of item "一键修复Mac安全拦截.command" to {410, 310}
    update without registering applications
    delay 5
    close
  end tell
end tell
APPLESCRIPT

sleep 5; sync; sleep 3

echo "→ 不卸载，直接从挂载状态压缩转换..."
rm -f "$OUT_DMG"
# 从设备节点直接转换，保持文件系统状态
hdiutil convert "$DEV" -format UDZO -imagekey zlib-level=9 -o "$OUT_DMG"

echo "→ 卸载..."
hdiutil detach "$DEV" -quiet 2>/dev/null || true
rm -f "$TEMP_DMG"
rm -rf "$STAGE"
echo "✓ 完成: $OUT_DMG ($(du -sh "$OUT_DMG" | awk '{print $1}'))"
