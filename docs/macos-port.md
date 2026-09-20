# macOS 移植路线图 (macOS Port)

> 目标：让 Claude Code Haha 在 macOS 上可编译、可运行、可分发。本文档随实施更新。
> 分支：`feature/macos-port`（已合并进 main 工作流）。当前平台状态：**构建管线完成，arm64 已发布；最新 mac 版 2026.08.26.4，Windows 侧已迭代至 2026.09.04.1 待同步**。

## 0. 结论先行

mac 化的**实质工作在三件事**，已全部落地：

1. **构建脚本平台化**（`scripts/build.ts` mac 分支：bun-darwin-arm64 / 官方 darwin 资产 / python pkg installer）✓
2. **组件路径/更新系统平台化**（`update.rs` 组件路径 cfg 分支 + osascript 提权替代 Update.exe）✓
3. **图标 + CI 出包 + 服务器平台化分发**（icon.icns + Codemagic + 服务器 `?platform=macos`）✓

CLI 引擎（`src/`）与 Rust 后端主体**跨平台干净**，mac 可直接启动。

## 1. 当前状态（2026-08-25）

| 项 | 状态 |
|----|------|
| CI 构建 | **Codemagic mac_mini_m2 全绿**（`Full macOS build` 3m55s，7m42s 总时长）——免费 macOS runner，替代 GitHub Actions 付费 runner |
| 产物 | arm64 全套：gui(.app)/claude/bun/tools/python/extensions 组件 zip + manifest |
| 服务器 | `updates.py` 平台化已部署 96 + 云（`{version}/macos/` 目录 + `?platform=macos` 参数）|
| 发布 | **mac 最新 2026.08.26.4**（96 + 云）· Windows 最新 2026.09.04.1（96 + 云，mac 未同步）· 08.25.3 为首个完整 ditto 版 |
| 架构决策 | 只出 arm64（Apple Silicon）；Intel x86_64 暂不支持，见「架构决策」节 |

### CI 配置

- `codemagic.yaml`：mac_mini_m2，`build.ts --platform macos --release ci-build`
- GitHub 镜像仓库 `o2bubble/claude-code-haha-rush`（private，孤儿快照分支，排除大文件）
- 产物作为 Codemagic artifact 下载（`.app`/claude/组件 zip/manifest）
- GitHub Actions `macos-build.yml` **已启用**（2026-09-16 起）——本仓库 public，macOS
  runner 免费；日常走它，要快时用 Codemagic。详见 `macos-build-playbook.md` §1
  （旧说法「保留但不用（runner 付费）」已过时）

### 构建管线要点（build.ts mac 分支）

- `claude`：`bun build --compile --target=bun-darwin-arm64`
- `gui`：`cargo tauri build --bundles app`（出 `.app`，非 dmg）
- `bun`：官方 `bun-darwin-arm64.zip`
- `tools`：rg/fd/jq/yq/shellcheck 官方 darwin arm64 资产
- `python`：**python-build-standalone**（Astral）tarball → 解压即 `dist/python`（真自包含，走 `@rpath`；`c107f64` 起）。~~python.org pkg → `installer -pkg -target /` → ditto 提取 framework → 瘦身~~（**已废弃**：框架式安装硬编码 `/Library/Frameworks/Python.framework/...` 绝对路径，ditto 拷副本救不了，用户系统框架升级后 `dyld: Library not loaded`）
- updater：mac 跳过（无 Update.exe）

## 2. 组件体系平台化

| 组件 | Windows | macOS |
|------|---------|-------|
| gui | `claude-code-gui.exe` | `Claude Code.app`（组件 zip 含 .app） |
| claude | `claude.exe` | 无后缀二进制（`bun-darwin-arm64` 编译） |
| bun | `bun.exe` | 自包含 `bun`（darwin arm64 官方二进制，非 brew） |
| tools | `rg/fd/jq/yq/shellcheck.exe` | 自包含 `rg/fd/jq/yq/shellcheck`（darwin arm64 资产） |
| python | 完整 python 3.12 zip | 自包含 python framework（arm64-only 瘦身版 + mcp SDK） |
| git | PortableGit zip | **系统自带**（无 git 组件） |
| extensions | 跨平台 | 跨平台，直接复用 |
| updater | `Update.exe`（提权存根） | **不需要**（无 updater 组件） |

服务器 mac 组件集：`{gui, claude, bun, tools, python, extensions}`。

## 3. 更新系统（mac 侧）

mac 无 Update.exe，更新链路全部内建在 GUI 进程（`update.rs`）：

- **GUI（.app）更新**：`prepare_gui_update_mac` → 下载 gui.zip → 解压 → `osascript "do shell script 'rm -rf 旧.app; ditto 新.app 目标' with administrator privileges"` 提权替换 → 返回空串 → `launch_updater_and_exit` 收到空路径即退出让用户重启
- **其他组件**：`download_and_install_component` → 先 try_install 直接写（用户目录安装）；`PermissionDenied` 走 `install_via_elevated_mac`（osascript 提权 ditto）
- **服务器**：`updates.py` 平台化——`updates-store/{version}/macos/` 存 mac manifest + 组件 zip；`/api/updates/latest?platform=macos` 按平台取最新；客户端 `check_for_updates` 按 `target_os` 加参数，下载 URL 带 `?platform=macos`

## 4. 分发

- **Windows**：Inno Setup `.exe` + 更新服务器组件。
- **macOS**：**完整 .app**（build.ts embed 组件进 `Contents/MacOS/`，gui.zip 163MB 开箱即用）+ 分体组件 zip（增量更新）。**组件 zip 用 ditto 打**（保留 symlink/权限，仅 gui `--keepParent`，其余内容入根——zip -r 会丢 symlink + 无顶层目录，.25.2 因此被取代）。**未签名/未公证**——见「架构决策」签名决策（熟人分发，不买 Developer ID，用户右键打开/xattr 绕过 Gatekeeper）。
- **发布流程**：Codemagic 出包 → 下载 artifacts → `temp/release_mac_20260825_3.py` 改正式版本号 → 上传 96（requests）+ 云（workbench）`/api/updates/{ver}/upload?platform=macos`

## 5. 实施进度

```
Phase 1  装环境跑起来        ✅ CI 直接完成（Codemagic 全绿）
Phase 2  GUI 出包            ✅ cargo tauri build 出 .app
Phase 3  组件/更新平台化     ✅ build.ts mac 分支 + update.rs cfg 分支 + 服务器 ?platform
Phase 4  签名发布            ⏳ 已发布未签名（Codemagic artifact 分发）；签名/公证待 Apple Developer 账号
Phase 5  与 Windows 版本同步 ⏳ Windows 已迭代至 2026.09.04.1（子代理可靠性/唤醒队列/i18n），mac 待出 2026.09.04.x 对齐
```

### 5.1 Windows 侧已积累、mac 待同步的改动（08.26.4 之后）

08.26.4 → 09.04.1 之间 main 上的 15+ 提交，跨平台改动 mac 构建天然包含：

| 批次 | commit | 平台组件 |
|------|--------|---------|
| 守卫/子代理面板升级 | dc00cc7…0f8ad5e | gui + claude |
| GLM thinking 链路 4 修 | d8e19ff…5936abc | claude + gui + gui-rust |
| [req] stderr 诊断行 | b462133 | claude |
| i18n 补齐（8 文件 60 处） | f856935 + b0e7fc4 | gui |
| 子代理假完成/自动重试/token NaN | 8cea5b8…5b94dd1 | claude + gui |
| 唤醒队列泄出竞态 | 8271272 | gui |

全部为跨平台代码（TS/Rust），无 Windows 专属分支 → mac 出下一版时直接继承。

## 6. 风险点 / 已知限制

- **mac 签名/公证**：**决策不买**（熟人分发，见架构决策）——从浏览器下载的 .app 会被 Gatekeeper 拦，用户首次右键打开/`xattr -cr` 一次性绕过；AirDrop/局域网共享不经过 quarantine 无拦截。
- **mac 默认 bash 3.2**：`bin/claude-haha` 用 `[[ ]]`/数组/`set -euo pipefail`，3.2 兼容；若引入 bash 4+ 特性需注意。
- **python.zip 体积**：162MB 偏大（瘦身后），后续可再砍（idle 相关、文档、pyc）。
- **MCP/桌面/语音** 按平台守卫，mac 上隐藏，需验证 lazy-load 不报错。
- **服务器云（123.56.66.84）公网被封**：workbench 走阿里云内网通道可用，但外网 mac 用户直连 8765 可能不通。

## 7. 架构决策（2026-08-25）

- **只构建 arm64**（Apple Silicon）：Codemagic mac_mini_m2 全 arm64 管线。
- **不构建 x86_64**：Apple 2023 停产 Intel Mac，macOS 26 是最后支持 Intel 的版本，Intel 用户少数派；且程序非计算密集，将来可用 Rosetta 2 转译 x86_64（arm64 app 不能跑 Intel，反向也不行）。
- **未来若要支持 Intel**：bun-darwin-x64 + python 保留 x86_64（或 universal2）+ `cargo tauri --target x86_64-apple-darwin` + 服务器 manifest 细分 macos-arm64/macos-x64 + CI 有 Intel 实例。有真实需求再扩。
- **签名决策**：**不买 Apple Developer 账号**（$99/年），不做 Developer ID 签名 + notarization。分发范围限熟人，首次打开右键 → 打开 / `xattr -cr` 绕过 Gatekeeper；除非将来公开分发，否则签名不列入待办。

## 8. 验证清单

- [x] mac CI 构建全绿（Codemagic mac_mini_m2）
- [x] 服务器平台化（96 + 云，`?platform=macos` 生效）
- [x] mac 发布 2026.08.25.3 到 96 + 云（ditto 打包，完整 .app 组件全内置）
- [x] mac 发布 2026.08.26.4（DeepSeek/effort 切换 + profile 能力迁移 + 压缩修复）
- [x] 更新面板能拉 mac manifest（`/api/updates/latest?platform=macos`）
- [ ] 真机 Mac 安装 .app + 走更新链路验证（待用户有 Mac）
- [ ] mac 出 2026.09.04.x 对齐 Windows（Codemagic 已触发，产物下载后走 playbook §3）
