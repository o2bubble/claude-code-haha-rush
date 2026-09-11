#!/bin/bash
# 一键安装 Claude Code（mac）— 自动解压/安装/清隔离/启动
# 用法: bash install-mac.sh [gui.zip 路径]
# 默认找脚本同目录下的 gui.zip; 也可 bash install-mac.sh /路径/gui.zip
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_ZIP="${1:-$SCRIPT_DIR/gui.zip}"
[ -f "$GUI_ZIP" ] || { echo "找不到 gui.zip: $GUI_ZIP"; echo "用法: bash install-mac.sh /路径/gui.zip"; exit 1; }

echo "[1/4] 解压 gui.zip..."
TMP=$(mktemp -d)
unzip -q "$GUI_ZIP" -d "$TMP"

APP=$(find "$TMP" -maxdepth 2 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "zip 里没找到 .app"; ls "$TMP"; exit 1; }
echo "      找到: $(basename "$APP")"

echo "[2/4] 安装到 /Applications（会要你输密码）..."
sudo cp -R "$APP" /Applications/
INSTALLED="/Applications/$(basename "$APP")"

# sudo cp 让 .app 变成 root 属主 → 用户跑 xattr / GUI 写 python/pip 会
# Permission denied。改回当前用户属主。
echo "      修正属主（root → 当前用户）..."
sudo chown -R "$USER":staff "$INSTALLED"

echo "[3/4] 清除 Gatekeeper 隔离属性..."
xattr -cr "$INSTALLED"

echo "[4/4] 启动..."
open "$INSTALLED"
rm -rf "$TMP"
echo "✅ 安装完成: $INSTALLED"
