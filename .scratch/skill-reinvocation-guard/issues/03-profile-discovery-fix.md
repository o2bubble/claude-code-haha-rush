# IDE 插件模型 Profile 发现修复

Status: done

## 问题

`gui-profile.py` / `claude-profile` 写入 profile 到 `~/.claude/.env.profiles/`，但三个 IDE 插件的 `getProfilesDir()` 都不查用户目录，导致模型下拉列表为空。

## 修复

三个 IDE 插件的 `getProfilesDir()` 各加一级 `~/.claude/.env.profiles` 查找：

| 插件 | 文件 | 优先级 |
|------|------|--------|
| VS Code | `provider.ts` | Priority 4 |
| IntelliJ | `ModelProfileManager.kt` | Priority 4 |
| Visual Studio | `ClaudeChatWindowControl.xaml.cs` | Priority 2 |

## 关联文件

- VS Code: `extensions/vscode/src/webview/provider.ts`
- IntelliJ: `extensions/intellij/src/main/kotlin/com/claude/code/ModelProfileManager.kt`
- Visual Studio: `extensions/vs/ClaudeCodeVS/ToolWindows/ClaudeChatWindowControl.xaml.cs`
- Installer: `installer/setup.iss` — Python 提示词更新
- Build: `scripts/build.ts` — IntelliJ ZIP 路径修正
