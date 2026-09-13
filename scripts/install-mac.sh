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
trap 'rm -rf "$TMP"' EXIT          # 异常/中断也清理（原先只在成功路径末尾删）
unzip -q "$GUI_ZIP" -d "$TMP"

# 先按已知名字找（gui.zip 的顶层就是它，见 build.ts 的 --keepParent），
# 找不到再回退 find。**不用 find | head -1 直接取第一个** —— 万一 zip 里有
# 意外嵌套的 .app（框架目录里常见），会静默选错那个，报错也不指向真问题。
APP="$TMP/Claude Code.app"
if [ ! -d "$APP" ]; then
  APP=$(find "$TMP" -maxdepth 2 -name "*.app" -type d | head -1)
fi
[ -n "$APP" ] && [ -d "$APP" ] || { echo "zip 里没找到 .app"; ls "$TMP"; exit 1; }
echo "      找到: $(basename "$APP")"

echo "[2/4] 安装到 /Applications（会要你输密码）..."
INSTALLED="/Applications/$(basename "$APP")"
# **先删旧的再拷** —— `cp -R` 对已存在目录是"合并覆盖"，升级时会留下
# 新旧混杂的文件（旧版本多出来的文件不会被清掉），可能表现为诡异的行为差异。
# ditto 比 cp -R 更适合 .app（正确处理权限/扩展属性/符号链接）。
if [ -d "$INSTALLED" ]; then
  echo "      检测到已安装版本，先移除旧的..."
  sudo rm -rf "$INSTALLED"
fi
sudo ditto "$APP" "$INSTALLED"

# sudo 让 .app 变成 root 属主 → 用户跑 xattr / GUI 写 python/pip 会
# Permission denied。改回当前用户属主。
echo "      修正属主（root → 当前用户）..."
sudo chown -R "$USER":staff "$INSTALLED"

echo "[3/4] 清除 Gatekeeper 隔离属性..."
xattr -cr "$INSTALLED"

echo "[4/4] 启动..."
open "$INSTALLED"
echo "✅ 安装完成: $INSTALLED"
