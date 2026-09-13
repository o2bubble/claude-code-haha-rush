# macOS 构建发布手册（Playbook）

> **操作手册**：照做即可发一次 mac 版本。架构细节/决策见 `docs/macos-port.md`。写于 2026-08-25（.25.3 验证通过），2026-09-04 更新（代理坑 + .26.4→09.04 同步流程）。

## 0. 架构决策速查

- **只出 arm64**（Apple Silicon）；不构建 x86_64（Intel 用户少数派，macOS 26 弃 Intel）
- **不签名/不公证**（熟人分发，不买 Developer ID $99/年）→ 用户首次右键打开 / `xattr -cr` 绕过 Gatekeeper
- mac 组件集：`{gui, claude, bun, tools, python, extensions}`（无 git=系统自带、无 updater=osascript 提权替代）
- mac 无更新 stager：gui→osascript 提权 ditto 替换 .app；其他组件→osascript 提权复制

## 1. 构建流程（触发 CI）

Codemagic（免费 mac_mini_m2）自动监听 GitHub 镜像仓库 push。改代码后：

```bash
# 1. 提交到本地 main
git add <files> && git commit -m "..."

# 2. push gitee main（主仓库）
git push origin main

# 3. sync 到 GitHub 触发 Codemagic（关键！不 sync 不构建）
bash scripts/sync-github-clean.sh
# → 推 GitHub main + gitee github-clean，Codemagic 收到 push 自动构建
```

**⚠️ 代理坑（2026-09-04）**：本机 git global http.proxy = `socks5h://127.0.0.1:17891`，代理进程死了会 `Failed to connect to 127.0.0.1 port 17891`。绕过法（不动全局配置）：

```bash
git -c http.proxy= -c https.proxy= push https://github.com/o2bubble/claude-code-haha-rush.git HEAD:main
```

若 `sync-github-clean.sh` 因此半途失败（gitee github-clean 段没推），单独补推该远端。

**CI 产物**：`build.ts --platform macos --release ci-build` 生成 6 组件 zip + `dist/release/ci-build/manifest.json`（version=ci-build）。

**构建耗时**：~8 分钟（Full build ~4min）。构建页 Codemagic UI 看结果。

## 2. 产物下载与验证

从 Codemagic 构建页下载 artifacts。**必须下载 build.ts 打的 zip**（`gui.zip` 等），**不要用 Codemagic 自动打的 `Claude_Code.app.zip`**（symlink 全丢，见踩坑）。

```bash
# 下载到 ~/Downloads 后，验证 zip 结构（python）：
python - <<'PY'
import zipfile, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
z = zipfile.ZipFile(r"路径\gui.zip")
names = z.namelist()
tops = sorted(set(n.split('/')[0] for n in names))
syms = sum(1 for i in z.infolist() if ((i.external_attr >> 16) & 0o170000) == 0o120000)
print("顶层:", tops[:3], "symlink:", syms)
PY
```

**验收标准**：
- `gui.zip` 顶层 = `['Claude Code.app']`，symlink > 0（约 41）
- `python.zip`/`tools.zip`/`extensions.zip` 顶层 = 内容目录（`Headers/Python/...`、`fd/jq/...`），**无 python/ bin/ 包裹层**，python 的 symlink > 0
- `claude.zip`/`bun.zip` 单文件，无 symlink

**⚠️ 区分新旧构建（关键）**：`gui.zip` 内嵌 manifest 的 gui sha 是 `dirMetaHash`（`(path,size)` 摘要）——前端嵌入 `claude-code-gui` 二进制，若内容变但 size 恰好不变，sha 不变，**无法判断是否新构建**。必须 byte 级对比 `claude-code-gui`：

```bash
python - <<'PY'
import zipfile, hashlib
# 新构建 gui.zip 的 claude-code-gui byte sha
z = zipfile.ZipFile(r"~Downloads/gui (1).zip")
d = z.read("Claude Code.app/Contents/MacOS/claude-code-gui")
print("新构建:", hashlib.sha256(d).hexdigest()[:16], len(d))
# 与 96 上一版本 gui.zip 对比（下载后同样提取 claude-code-gui）
PY
```
byte sha 与上一版本**不同**才证明前端改动编进去了（.25.5 事件：.25.3 二进制 `b1d5ef98` / 新构建 `73d51e78`）。

## 3. 发布流程（96 + 云）

```bash
# 1. 组织产物到 dist/macos-release-<ver>/（或直接用 ~/Downloads，脚本 ART 指向哪算哪）
mkdir -p dist/macos-release-2026.XX.XX.N
cp ~/Downloads/gui.zip ~/Downloads/python.zip ~/Downloads/tools.zip ~/Downloads/extensions.zip dist/macos-release-.../

# 2. 写/改发布脚本 temp/release_mac_<ver>.py（模板：temp/release_mac_20260826.4.py —— 比 .25.3 模板多了 dir_content_hash 覆盖）
#    改 VERSION + ZIPS（看本次哪些组件变了）+ HEAD notes（首条，中文 · 列表）
#    脚本自动拉 96 上一版 mac notes 累积；gui sha 用 dir_content_hash 覆盖（防 size-only 漏检）

# 3. 生成 manifest + 上传 96 + 验证
python temp/release_mac_<ver>.py make
python temp/release_mac_<ver>.py 96       # requests POST 到 192.168.186.96:8765
python temp/release_mac_<ver>.py verify   # latest?platform=macos + gui 下载大小

# 4. 上传云（workbench，后台跑，含大 zip 较慢）
python temp/release_mac_<ver>.py cloud    # workbench upload + exec curl
#    完成后 workbench exec curl 验证云端点
```

**Windows 侧同时发过版时（如 .26.4 → Windows 09.04.1 → mac 同步）**：HEAD notes 从对应 Windows 版 `--notes` 抄（内容一致，双平台同变更）；mac ZIPS 全 6 组件都传（claude/bun 单文件也变了）。

### ⚠️ 发布踩坑（2026-09-14 首次正式发 mac 版，四条都真实踩到）

**① 组件文件名必须规范 —— 否则该组件被「静默丢弃」**
服务端用 `upload.filename.rsplit(".",1)[0]` 判定组件名，不在 valid 集合里就 `continue`，
**不报错**。浏览器下载的 `gui (3).zip` → 解析出 `"gui (3)"` ≠ `"gui"` → **gui 被丢掉**，
接口却返回 `ok:true`（列出的 components 少一个，容易漏看）。
→ 上传前把本地文件映射成 `<component>.zip` 再传。

**② `workbench upload` 不会自动建目标目录**
缺目录报 `[FileTransfer.PathNoWritePermission] The specified path does not have write permission`
—— 报错文案指向权限，**真因是目录不存在**。先 `mkdir -p` + `chmod 777`。

**③ `workbench upload` 遇同名文件会交互式问覆盖**
输出 `Overwrite? [y/N]`，非交互环境直接当"取消"→ 上传失败。
→ 每次上传前 `rm -rf` 目标目录，从干净状态开始。

**④ `workbench` 输出含 Braille 进度字符（`⠋⠙⠹…`），Windows 控制台 GBK 会崩**
`UnicodeDecodeError: 'gbk' codec can't decode byte 0x8b` / 打印时 `UnicodeEncodeError`。
→ subprocess 传 `encoding="utf-8", errors="replace"`；运行脚本用 `PYTHONIOENCODING=utf-8`。

**验证下载端点时注意路径带 `/components/`**：
`/api/updates/{ver}/components/{comp}/download?platform=macos`（漏掉会 404，且响应体只有 22 字节，
容易被误读成"下载大小 22"）。

**mac 发布脚本**（本次重写，模板可复用）：`temp/macrel/release_mac.py`
—— `make` 从 gui.zip 内嵌 manifest 派生 → `cloud` 上传云 → `verify` 校验。
要点：`version` 从 `ci-build` 改正式号；gui 的 `sha256` 用 `dir_content_hash`
（逐文件内容 sha 聚合）覆盖内嵌的 `dirMetaHash`，防 size-only 漏检；gui 的 `size`
改成 **zip 实际大小**（内嵌值是解压后 .app 目录大小 427MB，会让下载进度显示异常）。

**manifest 源**：`gui.zip` 内嵌的 `Contents/MacOS/manifest.json`（CI 算的权威 sha，version=ci-build）。发布脚本读它 → 改 `version` + 注入 `release_notes`。

**⚠️ gui sha 覆盖（dirMetaHash size-only 坑）**：若内嵌 manifest 的 `components.gui.sha256` 与服务器上一版本**相同**，但 §2 的 byte 校验证明 claude-code-gui 变了（内容变 size 恰好不变）→ 客户端 check_for_updates 只对比 sha 值会漏更新。**发布脚本必须用内容 hash 覆盖 gui sha**（`temp/release_mac_*.py` 的 `dir_content_hash`，对 .app 内每文件算内容 sha 聚合），确保新版本 gui sha ≠ 旧版。

**版本号**：`2026.XX.XX.N`（今天日期 + 序号）。

## 4. 发布脚本模板要点

```python
VERSION = "2026.XX.XX.N"
ART = dist/macos-release-<ver>       # 产物目录
GUI_ZIP = ART/gui.zip
SRC_MANIFEST = 从 gui.zip 内嵌读取   # zipfile 读 Contents/MacOS/manifest.json
ZIPS = ["gui.zip", ...]              # 只列本次要传的
# make_manifest: 读 SRC_MANIFEST → 改 version + release_notes → 写 ART/manifest.json
# upload96: requests.post(url, data={"manifest":..., "platform":"macos"}, files=[...])
# uploadcloud: workbench upload 到 //tmp// + workbench exec curl POST localhost:8765
```

## 5. 踩坑经验（重要）

### 组件 zip 必须用 ditto 打，不能 zip -r
- `zip -r` 会：① 丢失 symlink（python framework 的 `Versions/Current`、lib 链接全没 → 装不上跑不了）② gui 无顶层 `Claude Code.app/` 目录（解压得 `Contents/`）
- **build.ts 已修**：mac 目录组件用 `ditto -c -k --sequesterRsrc [--keepParent] src dst.zip`
- **仅 gui 加 `--keepParent`**（更新链路 `walkdir_find("Claude Code.app")` 要顶层）；其他目录组件必须**内容入 zip 根**（客户端 `try_install copy_dir_recursive(temp_dir, dst)` 有顶层会复制出 `dst/python/python` 双层目录）
- 单文件组件（claude/bun）无 symlink，`zip -j` 打根即可

### 不要用 Codemagic 自动打的 `Claude_Code.app.zip`
- Codemagic 对 `dist/Claude*.app` 自动打的 zip **不保留 symlink**（验证 symlink=0）
- 必须用 build.ts 打的 `gui.zip`（ditto 版，symlink 保留）
- 分辨：`gui.zip`（build.ts，~163MB）/ `Claude_Code.app.zip`（Codemagic，symlink 丢）

### manifest sha 是"目录内容 hash"，与打包方式无关
- `gui.sha256` = `dirMetaHash(Claude Code.app 目录)`（path:size 对，**不含内容**）
- 改打包方式（zip -r → ditto）**不改 sha**，但改 zip 内容 → 解压后 hash 对不上 = 客户端永远提示更新
- 所以 ditto 版 zip 发布后，manifest sha 直接用 CI 内置值即可（目录内容没变）

### ⚠️ dirMetaHash size-only 漏检（.25.5 事件）
- `dirMetaHash` 用 `(path,size)`，**内容变但 size 恰好不变**时 sha 不变 → 客户端 check_for_updates（只对比 sha 值）**漏提示更新**
- 触发场景：mac `.app` 的 `claude-code-gui` 二进制嵌入前端，前端改了但二进制 size 恰好相同（.25.5：.25.3 的 gui sha=c2d5b168 / claude-code-gui byte=b1d5ef98；新构建 sha 仍=c2d5b168 / byte=73d51e78）
- **对策**：每次发版前 §2 byte 校验 `claude-code-gui`；字节变但内嵌 manifest 的 gui sha 与上一版相同 → 用内容 hash 覆盖 gui sha 再上传
- **勿改 dirMetaHash 为内容 hash**：会让全部 dir 组件（python/tools/git…）sha 算法突变 → 触发一次全量重下，代价大

### CI 产物 version 是 ci-build，发布必须改正式版本号
- 服务器 `VERSION_RE` 要求 `YYYY.MM.DD[.N]` 格式，ci-build 不合规

### 服务器组件复用
- upload 接口：manifest 引用但没上传的组件，**自动从前一版本复制 zip**
- 所以只传本次变化的组件即可（claude/bun 单文件常不变）

### python pkg 提取
- 用 `installer -pkg x.pkg -target /`（`pkgutil --expand-full` 对嵌套 pkg 不可靠）→ 从 `/Library/Frameworks/Python.framework` ditto 提取
- 瘦身：删 test/tkinter/idlelib/文档 + `lipo -thin arm64`

### bun/shellcheck asset 命名
- bun 用 `bun-darwin-aarch64.zip`（非 arm64）
- shellcheck 用 `darwin.aarch64.tar.xz`（非 arm64）

### Windows 解压 mac zip 的坑
- Windows unzip 不解 mac symlink（变普通文件/丢失）→ 在 Windows 上解压验证不了真实内容，只能看 zip 元数据（external_attr symlink 位）
- 真实结构靠 mac 端验证（有 Mac 后）

### Git Bash 调 workbench 报 named-pipe 错误
- 必须用 **Python subprocess** 调 workbench（Git Bash 直接调报 `missing port in address`）

## 6. 发布历史

| 版本 | 内容 | 备注 |
|------|------|------|
| 2026.08.25.1 | mac 首个版本（管线验证，空壳 .app）| 已取代 |
| 2026.08.25.2 | 完整 .app（组件内置）| zip -r 丢 symlink，已取代 |
| 2026.08.25.3 | ditto 打包修复版（symlink + 顶层目录正确）| 96+云已验证 |
| **2026.08.26.4** | **DeepSeek/effort 切换 + profile 能力迁移 + 压缩修复（dir_content_hash 引入）** | 已被取代 |
| **2026.09.14.1** | **对齐 Windows .13.8（插件 PATH 修复 / 笔记宽度）+ mac 专属修复（python 自包含、server 内嵌、打开终端、新建笔记、CDP 移除、菜单中文化）** | **当前 mac 最新（首次正式发布到云）** |

## 7. 待办 / 未验证

- [x] 真机 Mac 打开 .app → GUI 启动 → 后端 spawn（2026-09-13 用户实测，点出 6 个问题，均已修）
- [x] ~~python framework 在 mac 真机 import 正常~~ → 已改为 python-build-standalone（真自包含），不再依赖系统框架
- [x] ~~mac 2026.09.04.x 发布~~ → 2026-09-14 发布 `2026.09.14.1` 到云
- [ ] **`2026.09.14.1` 真机验证**：装后验 node/npm/npx 可用（PATH 修复）、
      诊断面板 GUI SERVER 运行中、打开终端、新建笔记、菜单中文
- [ ] **从 .13.9 之前版本升级到 `2026.09.14.1` 的更新链路**（客户端 check_for_updates
      → 下载 → osascript 提权替换）尚未真机验证 —— 这是"云端有 mac 版"后的第一要务
- [ ] python.zip 体积优化（现 41MB zip / 146MB 解压；standalone 已比原 framework 小 4 倍）
