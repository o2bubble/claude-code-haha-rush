# macOS 移植路线图 (macOS Port)

> 目标：让 Claude Code Haha 在 macOS 上可编译、可运行、可分发。本文档是工作路线图，随实施更新。
> 分支：`feature/macos-port`。当前平台状态：**Windows 已完善，macOS 未做任何编译**。

## 0. 结论先行

架构层面已为跨平台铺路，mac 化的**实质工作不在代码主体，而在三件事**：

1. **构建脚本平台化**（`scripts/build.ts` 全是 Windows 假设）
2. **组件路径/更新系统平台化**（`update.rs` 硬编码 `.exe` + Update.exe 提权）
3. **图标/签名/分发**（缺 `.icns`、需 codesign + notarization）

CLI 引擎（`src/`）与 Rust 后端主体**跨平台干净，无需改代码即可在 mac 启动**。

## 1. 现状评估（研究结论）

### 已就绪（mac 零改动可用）

| 模块 | 证据 |
|------|------|
| CLI 引擎 `src/` | `bin/claude-haha`/`bin/claude-ide` 是 bash 脚本；`Shell.ts`/`bashProvider.ts`/`ripgrep.ts`/`which.ts` 的 Windows 分支全被 `getPlatform()==='windows'` 门控 |
| Rust 依赖隔离 | `gui/src-tauri/Cargo.toml` Windows 依赖在 `[target.'cfg(windows)'.dependencies]` |
| GUI spawn 后端 | `lib.rs:1547` `build_ide_backend_command` 已有 mac 分支（`bash script`）；`find_ide_script` mac 找 `claude-ide`（无后缀，`bin/` 已有） |
| 进程树杀 | `backend.rs` `kill()` 有 `#[cfg(target_os="windows")]`，mac 走 `child.kill()` |
| 工具安装 | `install-tools.sh` 有 `Darwin|Linux` 分支（brew） |
| Tauri 跨平台 | `bundle.targets: "all"` 已配 |

### 要改（按文件定位）

| 文件 | Windows 假设 | mac 方案 |
|------|-------------|---------|
| `scripts/build.ts` | `.exe`/`.cmd`/`Compress-Archive`/`powershell`/`Inno Setup` | 平台分支：`cargo tauri build` 出 `.dmg`、claude 用 `bun build --compile --target=bun-darwin-*`、zip 用系统 zip/ditto |
| `gui/src-tauri/src/update.rs` | `get_component_path` 硬编码 `claude-code-gui.exe`/`claude.exe`/`bun.exe`/`Update.exe`；`install_via_stager` 提权 Update.exe | 组件名平台化（无 `.exe` 后缀）；mac 更新走 app 替换，不做 stager |
| `gui/src-tauri/src/diagnostics.rs` | registry/`reg.exe`/`GIT_BASH_PATH` 环境检查 | mac 换 launchctl/`~/.zprofile` 等价物，或按平台禁用该分类 |
| `gui/src-tauri/icons/` | 只有 png/ico | 需生成 `icon.icns`（mac bundle 必需） |
| `bin/*.exe`、`offline-tools/windows/*` | Windows 二进制 | mac 用 brew 装（`install-tools.sh` 已有） |
| 安装器 `installer/setup.iss` | Inno Setup（Windows 专属） | mac 用 Tauri bundle `.dmg`，不需要 |

## 2. 组件体系平台化

| 组件 | Windows | macOS |
|------|---------|-------|
| gui | `claude-code-gui.exe` | `Claude Code.app`（Tauri `.dmg`） |
| claude | `claude.exe` | mac 版二进制（无 `.exe`） |
| bun | `bun.exe` | brew `bun` 或官方安装脚本 |
| tools | `rg/fd/jq/yq/shellcheck.exe` | brew `ripgrep fd jq yq shellcheck` |
| python | 完整 python 3.12 zip | 系统自带 / brew python |
| git | PortableGit zip | 系统自带 git |
| extensions | 跨平台 | 跨平台，直接复用 |
| updater | `Update.exe`（提权存根） | **不需要**——mac app 更新走 bundle 替换 |

## 3. 更新系统（服务器侧）

- `update.rs get_component_path` 的 `.exe` 假设加 `cfg(target_os)` 分支。
- `install_via_stager` / `prepare_gui_update` / Update.exe 流程为 Windows 专属，mac 分支需设计替代（下载新 `.app` → 替换 `/Applications/Claude Code.app`，或交给 Tauri 更新插件）。
- 服务器 `manifest.json` 需区分平台：同版本不同平台组件名，或 mac 单独清单。建议 `gui`/`claude` 组件用平台后缀（`gui-win`/`gui-mac`）或在 manifest 加 `platform` 字段。

## 4. 分发

- **Windows**：Inno Setup `.exe` + 更新服务器组件。
- **macOS**：`.dmg` 或 `.app` zip，需：
  - `icon.icns`（首步）
  - codesign（Developer ID Application 证书）
  - notarization（`xcrun notarytool` + stapler）
  - 可选：Sparkle 或 Tauri 更新机制做 GUI 自更新

## 5. 实施路线（分阶段）

```
Phase 1  装环境跑起来
         mac 装 bun + brew install ripgrep fd jq yq shellcheck
         → ./bin/claude-haha 直接可用（CLI 零改代码验证）

Phase 2  GUI 出包
         生成 icon.icns → cargo tauri build → .app/.dmg 可启动
         验证 GUI spawn 后端（build_ide_backend_command mac 分支已就位）

Phase 3  组件/更新平台化
         build.ts mac 分支（或独立 build-mac.ts）
         update.rs 组件路径 cfg 分支 + 服务器 mac manifest
         diagnostics.rs mac 环境检查适配

Phase 4  签名发布
         codesign + notarization + .dmg 分发
         更新机制（mac 版）设计实现
```

## 6. 风险点

- **mac 签名/公证**：无 Developer ID 证书则 Gatekeeper 拦截，需申请 Apple Developer 账号（$99/年）。
- **mac 默认 bash 3.2**：`bin/claude-haha` 用 `[[ ]]`/数组/`set -euo pipefail`，3.2 兼容；若后续引入 bash 4+ 特性需注意。
- **GUI 更新链路**：Windows 的 stager/Update.exe 提权模式在 mac 无对应物，需重新设计，是 Phase 3/4 最大工作量。
- **MCP/桌面/语音**（`src/commands/desktop`、`src/voice`、`claudeInChrome`）已按平台守卫，mac 上会隐藏，但需验证 lazy-load 不报错。

## 7. 验证清单（每次阶段完成）

- [ ] mac 上 `bun install && ./bin/claude-haha -p "hi"` 能出结果
- [ ] `cargo tauri build` 产出 `.app`，双击能启动 GUI
- [ ] GUI 内进工作区 → 后端 spawn（bash 跑 `claude-ide`）→ WS 连上
- [ ] 更新面板能检查 manifest（mac 分支）
- [ ] `.dmg` 安装后通过 Gatekeeper（签名/公证）
