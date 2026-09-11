# Claude Code mac 手动升级指导（给 AI 看）

> **目标**：把目标 mac 上的 Claude Code 升级到 `2026.08.26.4`（含 DeepSeek/3P 思考+Effort、Profile 自动迁移、预设压缩修复、presetId 迁移）。
> **输入**：`gui.zip` —— 当前构建，ditto 打包的**完整 `.app`**（约 260MB），解压得 `Claude Code.app`，内部 `Contents/MacOS/` 已 embed **全部组件**（claude / bun / tools / python / extensions）。
> **参考**：`scripts/install-mac.sh`（首次安装流程）、`docs/macos-build-playbook.md`（mac 更新机制）。本指导针对**已有旧版 → 升级**；首次安装可简化直接走 §3。

## AI 先判断（§0）
```bash
# 已装？   (用户可能装在非标准位置)
ls -d /Applications/Claude\ Code.app 2>/dev/null || find /Applications "$HOME" -maxdepth 3 -name 'Claude Code.app' 2>/dev/null
# 当前版本（cli 版本，非 .26.4 的 gui 内部号)
/Applications/Claude\ Code.app/Contents/MacOS/claude --version 2>/dev/null
# 磁盘空间（zip 260MB + 解压 .app 更大 + 备份旧 .app，需几 GB）
df -h /Applications | tail -1
```
- 没装 → 全新安装（直接用 `gui.zip` 解压 + §3，无备份）。
- 已装且 cli 已是 2.1.89 / 同步新版 → 提示用户"已是最新"，终止。
- **gui 内部版本号**：`defaults read /Applications/Claude\ Code.app/Contents/Info CFBundleShortVersionString`（本版应为 `1.0.0-preview` 对不上 cli 号，以 cli `--version` + 功能为准）。

## §1 备份旧版（升级前，防回滚）
```bash
OLD=/Applications/Claude\ Code.app
if [ -e "$OLD" ]; then ditto "$OLD" "$HOME/ClaudeCodeBackup_$(date +%Y%m%d_%H%M).app"; fi
```
- 用 `ditto` 备份（保 symlink/权限）。回滚见 §7。
- **用户数据安全**：配置/资料在 `~/.claude`（settings/profiles/session/memory）与工作区 `.claude`，**不在 .app 内** → 整 .app 替换不会丢用户数据。
- 例外：若 `.app` 内曾被手动写入定制（如 `Contents/MacOS/extensions` 自定义），备份里保留，替换时可对比/带出。

## §2 解压 gui.zip（保留 symlink）
`gui.zip` 是 **ditto 打的**，`.app` 内的 symlink 是以 **zip 符号链接条目**存储的（external_attr 标记 + 目标路径字符串，实测 46 条、每条仅几字节）。mac 自带 `unzip` 和 `ditto -x -k` **都能还原**这些 symlink（`install-mac.sh` 用 unzip 已验证可用）。`ditto -x -k` 最稳；unzip 也行；**避免 `zip -r` 打的包**（那种把 symlink 展开成内容，才丢）。
```bash
TMP=$(mktemp -d)
ditto -x -k /path/to/gui.zip "$TMP"        # 或: unzip -q gui.zip -d "$TMP"
APP=$(find "$TMP" -maxdepth 3 -name '*.app' -type d | head -1); echo "$APP"
# 解压后验证 symlink（应 >0，约 41；为 0 多半是解压方式/包的问题，改 ditto 重来）
find "$APP" -type l | wc -l
```

## §3 替换 /Applications（需 sudo，用户输密码）
```bash
sudo ditto "$APP" /Applications/Claude\ Code.app
```
- **推荐 `ditto` 整体覆盖**（保权限/扩展属性/符号链接），不推荐先 `rm -rf` 再 `cp`。
- **sudo 需用户密码**：
  - AI 先探测 `sudo -n true && echo 免密 || echo 需密码`。
  - 若需密码 → **AI 不能代输**，把这条 sudo 交给用户执行（或让用户先 `sudo -v`），AI 不要以交互 sudo 卡住。
- 用户自定义路径时：把 `/Applications/Claude Code.app` 换成 §0 找到的实际路径。

## §4 属主修正（sudo 后必须）
sudo 替换后 .app 变 root 属主 → 用户跑 Python/pip/xattr 会 Permission denied：
```bash
sudo chown -R "$USER":staff /Applications/Claude\ Code.app
```

## §5 清 Gatekeeper 隔离（未签名、不公证）
```bash
xattr -cr /Applications/Claude\ Code.app
```
- 首次仍可能被拦 → `右键打开` 或再 `xattr -cr`。

## §6 启动 + 验证
```bash
# 若已有 GUI 在跑，先退出
pkill -f 'claude-code-gui' 2>/dev/null; osascript -e 'quit app "Claude Code"' 2>/dev/null
open /Applications/Claude\ Code.app
# 验证 cli 版本 + GUI 更新源
/Applications/Claude\ Code.app/Contents/MacOS/claude --version
# 若连内部更新服务(96/云)，看 mac latest 是否 .26.4
curl -s 'http://127.0.0.1:8765/api/updates/latest?platform=macos' 2>/dev/null | head -c 200
```

## §7 回滚（如需）
```bash
sudo ditto "$HOME/ClaudeCodeBackup_"*.app /Applications/Claude\ Code.app
sudo chown -R "$USER":staff /Applications/Claude\ Code.app
xattr -cr /Applications/Claude\ Code.app
```

## AI 决策要点（哪些覆盖 / 哪些要用户执行）
| 决策 | 结论 |
|---|---|
| 覆盖范围 | **只替换 `/Applications/Claude Code.app`**（完整 .app 已含 gui/claude/bun/tools/python/extensions 全部组件）。**无需**单独升其它组件。用户配置全部在 `~/.claude` / 工作区 `.claude`，不覆盖、不触碰。 |
| 无需动 | 系统级 bun/python/git（.app 自包含，不依赖外置）。用户之前单独装的同款不冲突（.app 用自己的 Contents/MacOS 副本）。 |
| 必须用户执行 | **所有 `sudo`**（替换 §3、属主 §4）——AI 提示用户运行/输密码；`ditto` 备份、`xattr -cr`、`open` 等非 sudo 部分 AI 可自行执行。 |
| 备份 | 升级前 `ditto` 备份旧 .app（§1）；用户数据不因升级丢失。 |
| GUI 在跑 | 替换前先退出（§6 的 pkill/osascript），否则替换可能失败或残留旧进程。 |
| 字段门槛 | gui 内部版本号可能不变（`1.0.0-preview`），以 `claude --version` + 实际功能（思考/Effort/压缩修复）判断是否升级成功。 |

## 一句话给 AI
> 在目标 mac：确认已装 → `ditto` 备份旧 .app → `ditto -x -k` 解压 `gui.zip` 得 `Claude Code.app`（验证 symlink>0）→ **请用户执行** `sudo ditto` 覆盖 + `sudo chown -R $USER:staff` → `xattr -cr` → 退出旧 GUI 后 `open`。整 .app 替换即可，用户配置在 `~/.claude` 不受影响，未签名 app 靠 `xattr -cr` 绕过 Gatekeeper。
