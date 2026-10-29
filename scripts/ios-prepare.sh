#!/usr/bin/env bash
#
# cap add ios 生成工程之后修补 Info.plist：
#   · 放开 ATS  —— 源站大量是 http 明文（采集接口、海报、部分 m3u8）
#   · 后台音频  —— M1 的后台播放与画中画要它，M0 加上无副作用
#   · 横屏方向  —— 播放器要能横过来
#
# 用法：bash scripts/ios-prepare.sh [Info.plist 路径]
set -euo pipefail

PLIST="${1:-ios/App/App/Info.plist}"
PB=/usr/libexec/PlistBuddy

if [ ! -f "$PLIST" ]; then
  echo "找不到 Info.plist: $PLIST" >&2
  exit 1
fi

set_bool() {
  local key="$1"
  local val="$2"
  $PB -c "Set :$key $val" "$PLIST" 2>/dev/null || $PB -c "Add :$key bool $val" "$PLIST"
}

# ── ATS ─────────────────────────────────────────────
if ! $PB -c "Print :NSAppTransportSecurity" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :NSAppTransportSecurity dict" "$PLIST"
fi
set_bool "NSAppTransportSecurity:NSAllowsArbitraryLoads" true
set_bool "NSAppTransportSecurity:NSAllowsLocalNetworking" true

# ── 后台音频 ────────────────────────────────────────
if ! $PB -c "Print :UIBackgroundModes" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :UIBackgroundModes array" "$PLIST"
fi
if ! $PB -c "Print :UIBackgroundModes:0" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
fi

# ── 方向：竖屏 + 左右横屏 ───────────────────────────
for key in "UISupportedInterfaceOrientations" "UISupportedInterfaceOrientations~ipad"; do
  $PB -c "Delete :$key" "$PLIST" 2>/dev/null || true
  $PB -c "Add :$key array" "$PLIST"
  $PB -c "Add :$key:0 string UIInterfaceOrientationPortrait" "$PLIST"
  $PB -c "Add :$key:1 string UIInterfaceOrientationLandscapeLeft" "$PLIST"
  $PB -c "Add :$key:2 string UIInterfaceOrientationLandscapeRight" "$PLIST"
done

echo "── Info.plist 修补完成，关键字段如下 ──"
$PB -c "Print :NSAppTransportSecurity" "$PLIST"
$PB -c "Print :UIBackgroundModes" "$PLIST"
$PB -c "Print :UISupportedInterfaceOrientations" "$PLIST"
