# macOS 构建发布手册（Playbook）

> **操作手册**：照做即可发一次 mac 版本。架构细节/决策见 `docs/macos-port.md`。写于 2026-08-25（.25.3 验证通过），2026-09-04 更新（代理坑 + .26.4→09.04 同步流程），2026-09-18 更新（本机构建前置三坑 + `macos-private-api` 必开 + python 方案改 standalone）。

## 0. 架构决策速查

- **只出 arm64**（Apple Silicon）；不构建 x86_64（Intel 用户少数派，macOS 26 弃 Intel）
- **不签名/不公证**（熟人分发，不买 Developer ID $99/年）→ 用户首次右键打开 / `xattr -cr` 绕过 Gatekeeper
- mac 组件集：`{gui, claude, bun, tools, python, extensions}`（无 git=系统自带、无 updater=osascript 提权替代）
- mac 无更新 stager：gui→osascript 提权 ditto 替换 .app；其他组件→osascript 提权复制
- **`gui.zip` 内嵌全部组件**（见下方「已知取舍」）—— 首次安装开箱即用，代价是改 GUI 要下整包

### ⚠️ 已知取舍：改 GUI 要下整包 137MB（比 Windows 体验差）

**现象**：mac 上任何 Rust 侧改动（`update.rs` / `lib.rs` / `diagnostics.rs` …）都要重下
**整个 `gui.zip`（137.5MB）**；而 Windows 改 GUI 只下 `gui.zip`（24MB，因为 `.exe` 是独立文件）。

**实测构成**（`gui.zip` 压缩后，2026-09-15 量）：

| 内容 | 大小 | 改 GUI 时真需要吗 |
|---|---|---|
| **`claude-code-gui`**（GUI 二进制本体） | **23.2 MB** | ✅ **只有它变** |
| python | 38.5 MB | ❌ |
| claude | 29.0 MB | ❌ |
| bun | 19.1 MB | ❌ |
| bin (rg/fd/jq/yq/shellcheck) | 17.5 MB | ❌ |
| claude-gui-server | 5.1 MB | ❌ |
| extensions | 3.7 MB | ❌ |

**浪费 ≈ 114MB / 137MB（83%）。**

**根因**：macOS 的 `.app` 是目录 bundle，**更新走 `ditto` 整目录替换**（`update.rs`
的 `prepare_gui_update_mac`：`rm -rf <dst>; ditto <new> <dst>`），所以必须整包下发。
组件内嵌进 `.app/Contents/MacOS/` 是为了**首次安装开箱即用**（不必逐个下载拼装）。

**注意**：更新面板**不会**因此全量下载 —— 它逐组件比 sha，**只下变化的组件**。
`gui.zip` 那个 137MB 只在「gui 组件变了」或「全新安装」时下。所以本取舍的实际
影响是「改 GUI 时流量大」，不是「每次更新都全下」。

**三条改进路（都未做，2026-09-15 决定暂缓）**：

| | 做法 | 代价 |
|---|---|---|
| **A** | `.app` 只含 GUI 本体，组件独立装到 `Contents/MacOS/` 子目录，更新时只换 GUI 二进制 | 省 83%，但**要重做 mac 更新逻辑**（不能再用 ditto 整目录替换），风险大 |
| **B** | 接受现状，更新面板显示真实下载量 | 零成本，只改善预期 |
| **C** | 改 GUI 时发一个只含 `claude-code-gui` 的差分包，用 ditto 单独替换那个文件 | 不动结构，风险小于 A；**需先实测**替换 `.app` 内单文件是否被 macOS 缓存/签名机制干扰（本包未签名，理论可行但未验） |

**倾向 C**（改动小、收益大）。做之前先验证：替换单个文件后 `.app` 能正常启动、
`codesign -v` 的表现与整包替换一致。

## 1. 构建流程（触发构建）

**两条路，按需选**（2026-09-16 起 GitHub Actions 已启用）：

| | GitHub Actions | Codemagic |
|---|---|---|
| 触发 | **push 到 GitHub 快照即自动跑**，或 Actions 页手动 Run workflow | 用户在 Codemagic 平台侧触发 |
| 费用 | **免费**（本仓库 public，macOS runner 不限分钟） | $0.095/分钟（约 ¥9/次），且只收实体卡 |
| 速度 | 较慢（无缓存，Tauri CLI 每次源码编译 → 全程 15-25 分钟） | 较快（有缓存，约 13 分钟） |
| 并发 | 已配 `concurrency`：连推自动取消旧 run | 免费档并发 1（会排队） |

**日常用 GitHub Actions**（免费）；**要快时用 Codemagic**。

**GitHub Actions 的两个硬约束**（都写进了 `.github/workflows/macos-build.yml`）：
- **必须 arm64 runner**（用 `macos-14`，**不要改 `macos-13`/`macos-latest`**）——
  build.ts 全链路硬编码 aarch64，落到 x86_64 runner 会编出 x86_64 的 `.app`。
  workflow 里有「Verify arm64 runner」自检步兜底。
- 本仓库是 **public** → Actions **日志与 artifact 对所有人可见/可下载**。
  构建只用公开 URL、无凭据，但**产物（含完整 .app）会公开**。

改代码后（GitHub Actions 路径）：

```bash
# 1. 提交到本地 main
git add <files> && git commit -m "..."

# 2. push gitee main（主仓库）
git push origin main

# 3. sync 到 GitHub —— 这一步会触发 GitHub Actions 构建
bash scripts/sync-github-clean.sh
# → 推 GitHub main + gitee github-clean
# 产物：GitHub 仓库 Actions 页 → 对应 run → 底部 artifact「claude-code-macos」
```

**⚠️ 代理坑（2026-09-04）**：本机 git global http.proxy = `socks5h://127.0.0.1:17891`，代理进程死了会 `Failed to connect to 127.0.0.1 port 17891`。绕过法（不动全局配置）：

```bash
git -c http.proxy= -c https.proxy= push https://github.com/o2bubble/claude-code-haha-rush.git HEAD:main
```

若 `sync-github-clean.sh` 因此半途失败（gitee github-clean 段没推），单独补推该远端。

**CI 产物**：`build.ts --platform macos --release ci-build` 生成 6 组件 zip + `dist/release/ci-build/manifest.json`（version=ci-build）。

**构建耗时**：Codemagic 实测 11m50s~14m40s；GitHub Actions 更久（无缓存，Tauri CLI 每次现编）。

### 本机（裸机）构建前置 —— 三个必踩的坑（2026-09-18 实测）

不走 CI、直接在本机跑 `bun run scripts/build.ts --platform macos` 时：

1. **`cargo tauri` 子命令需先装**（build.ts 里调的是 `cargo tauri build`，不是 npm 版 CLI）：
   ```bash
   cargo install tauri-cli --locked      # 源码编译，实测约 22 分钟
   ```
   装在 `~/.cargo/bin/`，若该目录不在 PATH，脚本会报 `no such command: tauri`。
   注意 npm 的 `@tauri-apps/cli` **不能**替代 —— build.ts 硬编码 `cargo tauri`。

2. **必须用 arm64 node**：PATH 里若有 nvm 的 x64 node（如 v18 跑在 Rosetta 下），
   vite/rollup 会报原生模块架构不兼容：
   ```
   Cannot find module './cli.darwin-universal.node'
   mach-o file, but is an incompatible architecture (have 'arm64', need 'x86_64')
   ```
   解法（不改全局）：`export PATH="/opt/homebrew/bin:$PATH"`（Homebrew node 是原生 arm64）。
   自检：`node -p process.arch` 应为 `arm64`。

3. **新拉代码后必须 `bun install`（gui/ 和仓库根各一次）**：新依赖只进 package.json、
   没同步进 node_modules 时，前端 `tsc` 直接失败。典型报错：
   ```
   error TS2307: Cannot find module '@tauri-apps/plugin-global-shortcut'
   ```
   —— 此前该插件只配了 Rust 侧（Cargo.toml + capabilities），JS 侧依赖漏装。

> 另：`build.ts` 给 cargo 调用设了 **10 分钟超时**（`timeout: 600000`）。首次构建
> 要下大量新 crate（如换 python 方案/加 feature 后），网络慢时会 `exit null` 被误杀，
> 日志只留一行 `[Error] GUI build failed (exit null)`。绕过：单独跑 `cargo tauri build`
> （无超时），再继续 build.ts 后续步骤。

### ⚠️ mac 跑 GUI dev 模式：`bin/claude-haha` 空数组 + `set -u` 崩溃

**现象**：macOS 上开工作区报 **「IDE backend did not start within timeout」**，
后端进程一启动就退出、从不打印 `CLAUDE_CODE_IDE_PORT=`。

**根因**：macOS 自带 `/bin/bash` 是 **3.2**。脚本头是 `set -euo pipefail`，
`--ide-mode` 分支下 `PROFILE_OPTS` 保持**空数组**，而 bash 3.2 在 `set -u` 下展开
空数组会直接报错退出（bash 4+ 才允许）：

```
bin/claude-haha: line 22: PROFILE_OPTS[@]: unbound variable
```

最小复现（bash 3.2）：
```bash
/bin/bash -c 'set -euo pipefail; A=(); echo "${A[@]}"'   # → A[@]: unbound variable
```

**修法**（`bin/claude-haha` 两处：recovery CLI 行 + 默认 exec 行）——用兼容惯用法：
```bash
${PROFILE_OPTS[@]+"${PROFILE_OPTS[@]}"}    # 有元素才展开，为空则安全展开成空
```

> 注意影响面：此坑只在**仓库/dev 布局**（`bin/claude-ide` → `bin/claude-haha`）出现。
> 打包版 `.app` 里的 `claude-ide` 是 build.ts 生成的 shim，直接 `exec ./claude --ide-mode`，
> 不经过该脚本，**不受影响**。

### ⚠️ mac 构建必须开 `macos-private-api`（否则编译不过）

`gui/src-tauri/src/lib.rs` 的覆盖层建窗无条件调用 `.transparent()`，而该方法在
**macOS 上被 feature 门控**：

```rust
#[cfg(any(not(target_os = "macos"), feature = "macos-private-api"))]
pub fn transparent(mut self, transparent: bool) -> Self
```

`not(target_os = "macos")` 那一支让 **Windows/Linux 天然满足条件**（所以只在 mac 暴露）。
缺 feature 时报：

```
error[E0599]: no method named `transparent` found for struct `WebviewWindowBuilder`
```

两处**配套**配置，缺一不可：

| 位置 | 内容 |
|---|---|
| `gui/src-tauri/Cargo.toml` | `tauri = { version = "2", features = ["devtools", "macos-private-api"] }` |
| `gui/src-tauri/tauri.conf.json` | `"app": { "macOSPrivateApi": true }` |

该 feature 传递链**不引入任何依赖**（`tauri-runtime/macos-private-api = []`、
`wry/transparent = []`、`wry/fullscreen = []` 均为空 feature），故对 Windows 产物
无影响；`tauri.conf.json` 的该字段在非 mac 平台被忽略。

（`Cargo.lock` 里 `tauri-runtime-wry` 原带 `source = registry + checksum`，与 Cargo.toml
的 `path = "vendor/tauri-runtime-wry"` 矛盾；cargo 在任何平台构建都会自动改成 path 依赖，
属既存不一致，非 mac 独有。）

## 2. 产物下载与验证

从构建页下载 artifacts —— **Codemagic**：构建页 artifacts 区；**GitHub Actions**：仓库
Actions 页 → 对应 run → 底部 artifact「claude-code-macos」（zip 内含全部组件）。

**必须用 build.ts 打的 zip**（`gui.zip` 等），**不要用平台自动打的 `Claude_Code.app.zip`**
或 `dist/Claude Code.app` 那棵树（自动打包不保留 symlink，装完起不来，见踩坑）。

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
# 1. 改 scripts/release_mac.py 顶部的四处配置：
#      VERSION        本次版本号（YYYY.MM.DD.N）
#      UPLOAD_ONLY    只列本次**内容真变了**的组件（其余由服务端从同平台上一版复制）；
#                     全量发布写 set(COMPONENTS)
#      COMPONENTS     组件 → 本地 zip 文件名（浏览器下载带 " (N)" 后缀没关系，
#                     上传时会映射成规范 <component>.zip。**sha 不在这里重算**）
#      RELEASE_NOTES  本次说明（首行 v<版本>）

# 2. 生成 manifest（从 gui.zip 内嵌 manifest 派生 + 改版本号 + 修 size）
python scripts/release_mac.py make

# 3. 上传云
python scripts/release_mac.py cloud
python scripts/release_mac.py verify

# 注意：96 内网通道目前不通（脚本只实现云）。补 96 时参照 cloud() 的
# requests POST（temp 里旧模板已丢失，见 git 历史）。
```

**发布后必做的一致性核对**（本次踩坑后加）：确认**云端每个组件的 sha == gui.zip
内嵌 manifest 的 sha**。两者不一致 = 客户端会一直报"有更新"。核对片段：

```python
import json, zipfile, urllib.request
z = zipfile.ZipFile("gui.zip")
emb = json.loads(z.read("Claude Code.app/Contents/MacOS/manifest.json"))
for n, v in sorted(emb["components"].items()):
    r = json.load(urllib.request.urlopen(
        f"http://<host>/api/updates/<ver>/components/{n}?platform=macos"))
    same = r["sha256"] == v["sha256"]
    print(f"{n:12} {'OK' if same else '!! 不一致'}")
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
输出 `Overwrite? [y/N]`，非交互环境直接当"取消"→ 上传失败（`upload canceled by user`）。
→ 每次上传前 `rm -rf` 目标目录，从干净状态开始。
→ **或更简单：加 `-f`**（`--force` = Overwrite remote file without confirmation），
   省掉一次 exec 调用。实测有效（2026-09-17 Windows 侧）。

**④ `workbench` 输出含 Braille 进度字符（`⠋⠙⠹…`），Windows 控制台 GBK 会崩**
`UnicodeDecodeError: 'gbk' codec can't decode byte 0x8b` / 打印时 `UnicodeEncodeError`。
→ subprocess 传 `encoding="utf-8", errors="replace"`；运行脚本用 `PYTHONIOENCODING=utf-8`。

**验证下载端点时注意路径带 `/components/`**：
`/api/updates/{ver}/components/{comp}/download?platform=macos`（漏掉会 404，且响应体只有 22 字节，
容易被误读成"下载大小 22"）。

**mac 发布脚本**：`scripts/release_mac.py`（2026-09-14 跑通完整流程后入库）
—— `make` 从 gui.zip 内嵌 manifest 派生 → `cloud` 上传云 → `verify` 校验。

**🔴 sha 一律沿用内嵌 manifest 的值，不要重新计算**（2026-09-14 定论，推翻了本文档
早先"必须用 `dir_content_hash` 覆盖"的说法 —— 那正是踩坑的原因）：

- 客户端读的**本地 manifest 就是 `.app` 内嵌的这份**（`update.rs` 的
  `local_manifest_path = Contents/MacOS/manifest.json`），其 sha 是构建期算的
  `dirMetaHash(path,size)`。
- 若发布时改用别的算法（内容 hash），**同一份内容两边算出不同值** →
  客户端 `local_sha != remote_sha` → **每次检查都报"有更新"**（实测：6 个组件全亮）。
- **比对算法必须与客户端本地 manifest 一致**，这是第一原则；"算法更敏感"必须让位。

**`size` 仍修正为 zip 实际大小** —— 内嵌值是**解压后目录**大小（gui 427MB vs zip
137MB），而客户端下载的是 zip，用错会让下载进度显示异常。`size` 不参与比对，纯展示。

**`remote_names` 映射按组件名派生，勿写死文件名** —— 服务端用
`upload.filename.rsplit(".",1)[0]` 判定组件，不在 valid 集合就**静默跳过**（接口
仍返回 `ok:true`，只是 components 列表少一项，极难察觉）。浏览器下载默认带 " (N)"
后缀，写死的映射在文件名变化后会失配。

**manifest 源**：`gui.zip` 内嵌的 `Contents/MacOS/manifest.json`（CI 算的权威 sha，version=ci-build）。发布脚本读它 → 改 `version` + 注入 `release_notes` + 修 `size`。

**⚠️ 已知代价（接受）**：沿用 `dirMetaHash` 就无法察觉"内容变但 size 恰好不变"
（原 `dir_content_hash` 方案能测出，见 §5「dirMetaHash size-only 漏检」）。权衡后
接受 —— 该场景极罕见，而算法不一致会导致**每次检查都误报**，代价大得多。
**若日后要改回内容 hash，必须同时改客户端**（让 `local_manifest_path` 指向的
manifest 也用内容 hash），否则重现本次的全量误报。

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

### ⚠️ `gui.zip` 内嵌 manifest 的 `size` 是陈旧的（build.ts 顺序问题，未修）
`build.ts` 的执行顺序：
```
① 算 sha/size（dirMetaHash + dirSize＝**解压后目录**大小）
② 写 manifest.json → 嵌入 .app/Contents/MacOS/
③ 【打包 gui.zip】        ← 封存了 ② 的旧版本
④ 生成其余组件 zip
⑤ 回填 size＝zip 实际大小，重写 release/、dist/、.app/（磁盘上）
```
⑤ 改的是 `dist/Claude Code.app/`，**但 `gui.zip` 早已打好** → zip 内那份永远是旧值。

**影响**：`.app` 内嵌 manifest 的六个 `size` 全是解压后目录大小（gui 427MB vs 实际
zip 137MB）。客户端下载的是 zip，用错会让**下载进度显示异常**。
**`sha` 不受影响**（sha 在 ① 算好，②③ 一致），所以不影响"有无更新"的判定 ——
发布脚本修正 `size` 即可（`scripts/release_mac.py` 已这么做）。

**未修的原因**：要修得把 gui.zip 的打包推迟到第 ⑤ 步之后，会动构建管线顺序，
风险大于收益（size 只是展示）。**若日后要修，注意 gui.zip 用的是
`ditto --keepParent`，移位时别丢这个参数。**

### ⚠️ dirMetaHash size-only 漏检（.25.5 事件）—— 已知代价，**接受**
- `dirMetaHash` 用 `(path,size)`，**内容变但 size 恰好不变**时 sha 不变 → 客户端 check_for_updates（只对比 sha 值）**漏提示更新**
- 触发场景：mac `.app` 的 `claude-code-gui` 二进制嵌入前端，前端改了但二进制 size 恰好相同（.25.5：.25.3 的 gui sha=c2d5b168 / claude-code-gui byte=b1d5ef98；新构建 sha 仍=c2d5b168 / byte=73d51e78）
- **早先的对策（已废弃）**：发布时用 `dir_content_hash` 覆盖 gui sha。**`2026-09-14` 实测证明这会砸锅** ——
  客户端本地 manifest 用的是 `dirMetaHash`，两套算法对同一份内容算出不同值 →
  **每次检查都误报"有更新"**（6 个组件全亮），比"漏检"严重得多。
- **现行对策**：
  1. 发布时**沿用内嵌 manifest 的 sha**（算法与客户端一致）——见 §3
  2. 发版前 §2 做 **byte 级** `claude-code-gui` 校验，确认改动真的编进去了（这只用于
     **人工确认构建有效性**，不再用于改 sha）
  3. 若 sha 与上一版恰好相同（size-only 场景）→ **用版本号区分**：改 `version` 字段即
     可（客户端 `_get_latest_version` 按版本号取最新，不依赖 sha 变化触发）
- **勿单方面改算法**：无论改成内容 hash 还是别的，**必须同时改客户端读的
  `local_manifest_path` 那份 manifest 的生成方式**，否则两边不一致 → 全量误报。

### CI 产物 version 是 ci-build，发布必须改正式版本号
- 服务器 `VERSION_RE` 要求 `YYYY.MM.DD[.N]` 格式，ci-build 不合规

### 服务器组件复用
- upload 接口：manifest 引用但没上传的组件，**自动从前一版本复制 zip**
- 所以只传本次变化的组件即可（claude/bun 单文件常不变）

### 内置 python 用 python-build-standalone（**旧 pkg 方案已废弃**）
- 现行：`python-build-standalone`（Astral）tarball，解压即为 `dist/python`（顶层就是
  `python/`，含 bin/lib/include/share，**无需再建 `bin/python3` 链接**）
- 版本固定在 build.ts 顶部：`PBS_TAG` / `PBS_PY` / `PBS_ARCH`（只出 aarch64-apple-darwin）
- ⚠️ 下载源是 `github.com/astral-sh/python-build-standalone/releases/...` —— 属被墙的
  **资产 CDN**（`release-assets.githubusercontent.com`）。拿不到时把 tarball 手动放到
  `offline-tools/macos/` 即可离线复用（该目录被 .gitignore 排除，不入库）
- **为什么废弃 python.org 的 .pkg**（2026-09-13，`c107f64`）：pkg 是框架式安装，二进制里
  **硬编码** `/Library/Frameworks/Python.framework/Versions/3.12/Python`（`LC_LOAD_DYLIB`
  绝对路径）。ditto 拷副本只搬文件、改不了二进制内的路径 → 用户系统框架升到 3.14 后
  3.12 的 dylib 没了，内置 python 直接 `dyld: Library not loaded`。
  **重建 symlink 也救不了**（问题不在链接，在绝对路径）→ "分发副本"从根上不成立。
  standalone 走 `@rpath` / `@executable_path/../lib`，libpython 随包分发，真自包含，
  顺带 176MB→24MB。
  （实测复现：pkg 解包后直接跑 `python3` 即报 dyld 找不到 framework path。）

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
| **2026.09.14.1** | **对齐 Windows .13.8（插件 PATH 修复 / 笔记宽度）+ mac 专属修复（python 自包含、server 内嵌、打开终端、新建笔记、CDP 移除、菜单中文化）** | 已被取代 |
| **2026.09.14.2** | **GUI 组件路径修复（更新面板误判「未安装」）+ 移除三个死 launcher；发布 sha 改为沿用内嵌 manifest（修全量误报）** | 已被取代 |
| **2026.09.15.5** | 自动更新两个必现 bug（`walkdir_find` 匹配不了目录 / 解压丢可执行位）+ 诊断面板「可执行权限」检测与一键修复 | 已被取代 |
| **2026.09.15.6** | MCP 子进程 spawn 与 mac 新终端拿不到插件 runtime PATH（`subprocessEnv` 注入 + `collect_plugin_runtime_dirs`） | **当前 mac 最新** |

> 注：`.14.2` 发布后 mac 通道曾被服务器 prune 误删（根因＝版本目录两平台共享 +
> 整目录 rmtree；已修，见 HANDOFF「续②」）。恢复时用 `~/Downloads` 既有产物重发为
> `.15.1`，故版本号有跳跃。

## 7. 待办 / 未验证

- [x] 真机 Mac 打开 .app → GUI 启动 → 后端 spawn（2026-09-13 用户实测，点出 6 个问题，均已修）
- [x] ~~python framework 在 mac 真机 import 正常~~ → 已改为 python-build-standalone（真自包含），不再依赖系统框架
- [x] ~~mac 2026.09.04.x 发布~~ → 2026-09-14 发布 `2026.09.14.1` 到云
- [x] ~~更新链路~~ → 发现两处必现 bug（`walkdir_find` 找不到 .app / 解压丢可执行位），
      已于 `.15.5` 修复；**修复只能靠更新送达，而旧版更新必挂** → mac 上须**手动装一次**
- [ ] **`2026.09.15.6` 真机验证**（当前最新，装机后验这三条）：
      ① **MCP spawn**：`claude mcp list` → playwright 应 ✓ Connected（`subprocessEnv` 注入 PATH 的验收点）
      ② **mac 新终端**：工具栏「打开终端」→ 里面 `node --version && npx --version` 可用
      ③ **AI Bash 回归**：`node/npm` 仍可用（改了 `subprocessEnv`，别弄坏原来好的）
      另：诊断面板应出现「可执行权限」检查项且通过；更新面板不再全量报"有更新"
- [ ] **从旧版自动更新到 `.15.5+` 的链路**尚未真机验证 —— 这是"两个更新 bug 已修"的验收点
- [ ] python.zip 体积优化（现 41MB zip / 146MB 解压；standalone 已比原 framework 小 4 倍）
- [ ] （暂缓）改 GUI 只下增量的分发结构 —— 见 §0「已知取舍」的 A/B/C 三方案
