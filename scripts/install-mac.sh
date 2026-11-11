#!/bin/bash
# 一键安装 Claude Code（mac）— 自动挂载/解压、安装、清隔离、启动
#
# 用法:
#   bash install-mac.sh                      # 自动找同目录的 .dmg 或 gui.zip
#   bash install-mac.sh /路径/镜像.dmg         # 指定文件（.dmg / .zip 都行）
#   bash install-mac.sh --user                # 装到家目录 ~/Applications（**不需要密码**）
#   bash install-mac.sh --user /路径/x.dmg
#
# 安装位置：
#   /Applications      系统级，多用户共享，需要 sudo
#   ~/Applications     当前用户级，**全程无需提权**（自己家目录自己写）
#  验证/试用阶段推荐 --user —— 省事、不动系统。
#
# **自动探测已有安装**：任一位置存在旧版时，更新那个位置（不另起一份）。
# 两个位置都有时优先 ~/Applications —— 用户级那份是他后来自己装的。
#
# 本脚本存在的意义：包未签名未公证，macOS 打开会报「已损坏，无法打开」。
# 用户不需要自己敲 xattr —— 脚本装完自动清隔离属性。
#
# ⚠️ **必须兼容 macOS 自带的 bash 3.2**（2007 年版本）：
#   · 不要用 `arr+=("x")` 追加数组（bash 4.0+ 才有；3.2 报
#     `syntax error near unexpected token ')'`）
#   · 不要用关联数组 `declare -A`、`${var,,}` 小写化等 4.x 特性
#   · 这里用 `set --` 位置参数代替数组收集，3.2/5.x 通吃
set -e

MODE=""
POSITIONAL=""
for a in "$@"; do
  case "$a" in
    --user|-u) MODE="user" ;;
    --system|-s) MODE="system" ;;
    --help|-h)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "未知参数: $a（可用: --user / --system）" >&2; exit 1 ;;
    *) POSITIONAL="$a" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. 找安装包 ──
# 显式给了路径就用它；否则在脚本同目录找 *.dmg（优先）或 gui.zip。
# DMG 优先：它带「拖到 Applications」的视觉引导，且是我们对外推荐的分发格式。
SRC_PKG="$POSITIONAL"
if [ -z "$SRC_PKG" ]; then
  for _c in "$SCRIPT_DIR"/*.dmg; do
    [ -f "$_c" ] && { SRC_PKG="$_c"; break; }
  done
  if [ -z "$SRC_PKG" ]; then
    if [ -f "$SCRIPT_DIR/gui.zip" ]; then
      SRC_PKG="$SCRIPT_DIR/gui.zip"
    fi
  fi
fi
[ -n "$SRC_PKG" ] && [ -f "$SRC_PKG" ] || {
  echo "找不到安装包。把 .dmg 或 gui.zip 放到脚本同目录，或显式指定路径："
  echo "  bash install-mac.sh /路径/xxx.dmg"
  exit 1
}

# ── 2. 探测安装位置 ──
# 没指定 --user/--system 时，看用户已经装在哪 —— 装在哪儿就更新哪儿，
# 绝不"另起一份"（两份并存会让用户分不清自己打开的是哪个）。
# 两个都有时优先 ~/Applications：用户级那份通常是后来手动装的。
USER_APP="$HOME/Applications/Claude Code.app"
SYS_APP="/Applications/Claude Code.app"
if [ -z "$MODE" ]; then
  if [ -d "$USER_APP" ]; then
    MODE="user"
    echo "检测到已有安装（用户级），将更新它"
  elif [ -d "$SYS_APP" ]; then
    MODE="system"
    echo "检测到已有安装（系统级），将更新它"
  else
    MODE="system"
    echo "未检测到已有安装，默认装到 /Applications（用 --user 可免密码）"
  fi
fi

if [ "$MODE" = "user" ]; then
  DEST_DIR="$HOME/Applications"
  SUDO=""                                   # 家目录不需要提权
  echo "安装位置: $DEST_DIR （用户级，无需密码）"
else
  DEST_DIR="/Applications"
  SUDO="sudo"
  echo "安装位置: $DEST_DIR （系统级，需要管理员密码）"
fi

# ── 3. 取出 .app ──
# 挂载点和临时解压目录都要在某条退出路径上清理。用变量记录，trap 统一处理 ——
# 中途 exit 1 时也不会把 DMG 一直挂在 /Volumes 里。
MOUNT_POINT=""
TMP=""
_cleanup() {
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || \
      hdiutil detach "$MOUNT_POINT" -force -quiet 2>/dev/null || true
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
}
trap _cleanup EXIT

case "$SRC_PKG" in
  *.dmg|*.DMG)
    echo "[1/4] 挂载 $(basename "$SRC_PKG")..."
    # -nobrowse：不弹 Finder 窗口（用户已经双击过 DMG 了，再弹一个是干扰）
    # -readonly：不改源镜像
    MOUNT_POINT=$(mktemp -d)
    if ! hdiutil attach "$SRC_PKG" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet; then
      echo "      [错误] 挂载失败。若提示「已损坏」，先执行：xattr -cr \"$SRC_PKG\"" >&2
      exit 1
    fi
    APP="$MOUNT_POINT/Claude Code.app"
    if [ ! -d "$APP" ]; then
      APP=$(find "$MOUNT_POINT" -maxdepth 2 -name "*.app" -type d | head -1)
    fi
    ;;
  *)
    echo "[1/4] 解压 $(basename "$SRC_PKG")..."
    TMP=$(mktemp -d)
    unzip -q "$SRC_PKG" -d "$TMP"
    # 先按已知名字找（gui.zip 的顶层就是它，见 build.ts 的 --keepParent），
    # 找不到再回退 find。**不用 find | head -1 直接取第一个** —— 万一 zip 里
    # 有意外嵌套的 .app（框架目录里常见），会静默选错那个。
    APP="$TMP/Claude Code.app"
    if [ ! -d "$APP" ]; then
      APP=$(find "$TMP" -maxdepth 2 -name "*.app" -type d | head -1)
    fi
    ;;
esac

[ -n "$APP" ] && [ -d "$APP" ] || {
  echo "      [错误] 安装包里没找到 .app" >&2
  exit 1
}
echo "      找到: $(basename "$APP")"

# 符号链接自检：ditto 打的包在 .app 内有约 40 条 symlink（python framework 等）。
# 若是用 zip -r 打的包，symlink 会被展开成实体副本 → 装完启动报错/体积翻倍。
# 这里只是提示，不阻断 —— 个别精简构建确实可能没有 symlink。
_LINKS=$(find "$APP" -type l 2>/dev/null | wc -l | tr -d ' ')
echo "      符号链接: $_LINKS 条"
if [ "$_LINKS" -eq 0 ]; then
  echo "      [警告] 该包没有符号链接，可能不是 ditto 打包的 —— 装完若起不来，换官方 DMG"
fi

echo "[1.5/4] 关闭正在运行的 Claude Code 进程..."
# **必须在替换 .app 之前杀干净**，否则：
#   · `rm -rf` 对正在执行的文件可能失败（"text file busy"），留下半旧半新的目录
#   · 即便替换成功，旧进程仍在跑（用户以为在跑新版，实际是内存里的旧版）
# 三类进程（都属本应用）：
#   claude-code-gui    GUI 本体（.app/Contents/MacOS/ 下的可执行文件）
#   claude-gui-server  GUI server 守护进程（同目录，2026-09-14 起随 .app 内嵌）
#   claude --ide-mode  后端引擎（每工作区一个）
# `pkill -f` 按完整命令行匹配，比 -x（只按进程名）可靠：`claude` 这个名字太常见，
# 只按名字会误杀用户自己装的其它 claude。匹配用**绝对路径片段**进一步收窄。
_kill_one() {
  local pat="$1" label="$2"
  if pkill -f "$pat" 2>/dev/null; then
    echo "      已终止: $label"
  fi
}
for _app_dir in "$HOME/Applications/Claude Code.app" "/Applications/Claude Code.app"; do
  _kill_one "$_app_dir/Contents/MacOS/claude-code-gui" "GUI 主进程"
  _kill_one "$_app_dir/Contents/MacOS/claude-gui-server" "GUI server"
  _kill_one "$_app_dir/Contents/MacOS/claude --ide-mode" "后端引擎"
done
# 兜底：按名字再扫一遍（覆盖从别处启动、路径不匹配的情况）。`-x` 精确匹配进程名，
# 不会波及用户的其它 claude（那些通常带路径或以其它名字运行）。
#
# ⚠️ 必须用 `if` 而非 `cmd && echo`：`set -e` 下，循环体最后一条命令失败会让
# **整个 for 返回非零** → 脚本当场中止（"没进程可杀"这种最正常的情况反而致命）。
for _name in claude-code-gui claude-gui-server; do
  if pkill -x "$_name" 2>/dev/null; then
    echo "      已终止: $_name（按进程名兜底）"
  fi
done
# 给进程一点退出时间，避免紧接着的 rm 撞上"文件忙"
sleep 1

echo "[2/4] 安装到 $DEST_DIR..."
mkdir -p "$DEST_DIR"
INSTALLED="$DEST_DIR/$(basename "$APP")"
# **先删旧的再拷** —— `cp -R` 对已存在目录是"合并覆盖"，升级时会留下
# 新旧混杂的文件（旧版本多出来的文件不会被清掉），可能表现为诡异的行为差异。
# ditto 比 cp -R 更适合 .app（正确处理权限/扩展属性/符号链接）。
if [ -d "$INSTALLED" ]; then
  echo "      检测到已安装版本，先移除旧的..."
  $SUDO rm -rf "$INSTALLED"
  # rm 失败（权限/残留）时不要静默继续 —— 否则 ditto 会叠在旧目录上，
  # 正是上面说的"新旧混杂"。宁可报错让用户看到。
  if [ -d "$INSTALLED" ]; then
    echo "      [错误] 旧版本目录删除失败: $INSTALLED" >&2
    echo "             可能仍有进程占用。请手动执行后重试：" >&2
    echo "               $SUDO rm -rf \"$INSTALLED\"" >&2
    exit 1
  fi
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
