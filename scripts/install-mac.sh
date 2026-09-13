#!/bin/bash
# 一键安装 Claude Code（mac）— 自动解压/安装/清隔离/启动
#
# 用法:
#   bash install-mac.sh                     # 默认找脚本同目录的 gui.zip，装 /Applications
#   bash install-mac.sh /路径/gui.zip        # 指定 zip 路径
#   bash install-mac.sh --user               # 装到家目录 ~/Applications（**不需要密码**）
#   bash install-mac.sh --user /路径/gui.zip
#
# 两个安装位置的区别只有「要不要管理员密码」，功能相同：
#   /Applications      系统级，多用户共享，需要 sudo
#   ~/Applications     当前用户级，**全程无需提权**（自己家目录自己写）
#  验证/试用阶段推荐 --user —— 省事、不动系统。
#
# ⚠️ **必须兼容 macOS 自带的 bash 3.2**（2007 年版本）：
#   · 不要用 `arr+=("x")` 追加数组（bash 4.0+ 才有；3.2 报
#     `syntax error near unexpected token ')'`）
#   · 不要用关联数组 `declare -A`、`${var,,}` 小写化等 4.x 特性
#   · 这里用 `set --` 位置参数代替数组收集，3.2/5.x 通吃
set -e

MODE="system"
POSITIONAL=""
for a in "$@"; do
  case "$a" in
    --user|-u) MODE="user" ;;
    --help|-h)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "未知参数: $a（可用: --user）" >&2; exit 1 ;;
    *) POSITIONAL="$a" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_ZIP="${POSITIONAL:-$SCRIPT_DIR/gui.zip}"
[ -f "$GUI_ZIP" ] || { echo "找不到 gui.zip: $GUI_ZIP"; echo "用法: bash install-mac.sh [--user] [gui.zip 路径]"; exit 1; }

if [ "$MODE" = "user" ]; then
  DEST_DIR="$HOME/Applications"
  SUDO=""                                   # 家目录不需要提权
  echo "安装位置: $DEST_DIR （用户级，无需密码）"
else
  DEST_DIR="/Applications"
  SUDO="sudo"
  echo "安装位置: $DEST_DIR （系统级，需要管理员密码）"
fi

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

echo "[2/4] 安装到 $DEST_DIR..."
mkdir -p "$DEST_DIR"
INSTALLED="$DEST_DIR/$(basename "$APP")"
# **先删旧的再拷** —— `cp -R` 对已存在目录是"合并覆盖"，升级时会留下
# 新旧混杂的文件（旧版本多出来的文件不会被清掉），可能表现为诡异的行为差异。
# ditto 比 cp -R 更适合 .app（正确处理权限/扩展属性/符号链接）。
if [ -d "$INSTALLED" ]; then
  echo "      检测到已安装版本，先移除旧的..."
  $SUDO rm -rf "$INSTALLED"
fi
$SUDO ditto "$APP" "$INSTALLED"

# sudo 让 .app 变 root 属主 → 用户跑 xattr / GUI 写 python/pip 会 Permission
# denied。改回当前用户属主。**仅系统级安装需要** —— 用户级装完就是自己的。
if [ -n "$SUDO" ]; then
  echo "      修正属主（root → 当前用户）..."
  sudo chown -R "$USER":staff "$INSTALLED"
fi

echo "[3/4] 清除 Gatekeeper 隔离属性..."
xattr -cr "$INSTALLED"

echo "[4/4] 启动..."
open "$INSTALLED"
echo "✅ 安装完成: $INSTALLED"
