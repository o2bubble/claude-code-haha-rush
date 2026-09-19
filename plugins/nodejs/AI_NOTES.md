# AI_NOTES — nodejs 插件排查文档（面向 AI）

本插件是 GUI 插件生态的运行时基础设施：为插件后台进程与 AI Bash 提供 Node.js LTS。
包内**不含** Node 本体——安装后需要你（AI）按本文档完成实际的环境安装。

## 平台检测（读取本文件前必做）

- 先确认当前平台：AI 上下文（系统提示 OS Version 行 / `process.platform`）已自带，
  如果你不知道该跑 `node -p process.platform`（`win32`→Windows、`darwin`→macOS、`linux`→Linux）。
- 本插件 manifest `platforms: ["windows","macos","linux"]`——全平台支持。
- **差异只在文件格式/验证路径/目录结构**（见下方分节）；AI 必须按当前平台读对应节，
  其余步骤通用。

## 你的任务：完成环境安装

用户安装本插件后（市场安装只放入文档骨架），按以下步骤装 Node。每步都有验证点，
失败时按对应 fallback 走。

### 第 1 步：确认插件目录与已装检测

- 安装根目录：
  - **Windows**：`%APPDATA%/com.claudecode.gui/plugins/nodejs/`
  - **macOS**：`~/Library/Application Support/com.claudecode.gui/plugins/nodejs/`
  - **Linux**：`~/.config/com.claudecode.gui/plugins/nodejs/`
- 已装检测（存在则跳过下载，直接做第 4 步验证）：
  - **Windows**：`runtime/node.exe`
  - **macOS/Linux**：`runtime/bin/node`

### 第 2 步：确定版本与架构

- 版本：**当前 LTS**（不钉死）。查 `https://nodejs.org/dist/index.json` 的最新 LTS 行
  （`lts` 字段非 false 的最大版本）；查不到时用已知稳定 LTS（如 v22.x）。
- 架构：`process.arch`（你所在进程）——按平台映射：
  - Windows：`x64` → `win-x64` / `arm64` → `win-arm64`
  - macOS：`x64` → `darwin-x64` / `arm64` → `darwin-arm64`
  - Linux：`x64` → `linux-x64` / `arm64` → `linux-arm64`

### 第 3 步：下载（端点 fallback 链，按顺序尝试）

对每个端点：下载 `node-v<版本>-<平台>-<架构>.zip`（**Windows**）或
`.tar.gz`（**macOS/Linux**——官方发行包只提供 tar 格式）。
**每次下载限时 120s**，失败信号 = HTTP 非 200 / 连接超时 / 文件 < 10MB（截断包）→ 立即切换下一级。

1. **npmmirror（国内首选）**：`https://registry.npmmirror.com/-/binary/node/v<版本>/<文件名>`
2. **华为云镜像（国内备选）**：`https://mirrors.huaweicloud.com/nodejs/v<版本>/<文件名>`
3. **官方（兜底）**：`https://nodejs.org/dist/v<版本>/<文件名>`

> ⚠️ **必须用版本化路径 `v<版本>/`，不要用 `latest-vXX.x` / `latest-krypton` 这类别名。**
> 实测（2026-09-14）：npmmirror 的 `latest-v24.x` 目录只同步到 v24.1.0，**没有** v24.21.0；
> `latest-krypton` 停在 v24.11.0 → 照别名拼 URL 会**直接 404**，白白浪费一级 fallback。
> 别名的滞后是镜像同步策略问题，不是我们的 bug —— 版本化路径才是稳定入口。
>
> 版本号来源：设置项 `defaultLtsMajor`（0 = 跟随最新 LTS）。确定为具体版本后再拼 URL。

下载到临时目录（Windows `%TEMP%/nodejs-plugin-download/`；macOS/Linux `/tmp/nodejs-plugin-download/`）。
**tar.gz 用 `tar -xzf` 解压，不是 zipfile。**

### 第 4 步：解压 + 拍平 + 验证

- 解压临时目录 → 解出 `node-v<版本>-<平台>-<架构>/` **内层目录**；
- 把**内层目录的内容**（不是目录本身）移入 `plugins/nodejs/runtime/`——
  多套一层是最常见安装失败原因，装完务必确认。
- **拍平后的结构（按平台）**：
  - **Windows**：`runtime/` 下直接是 `node.exe`、`npm.cmd`、`node_modules/`
  - **macOS/Linux**：`runtime/` 下是 `bin/`（node/npm）、`lib/`、`include/`、`share/`（官方 tar 布局）
- 验证：
  - **Windows**：`runtime/node.exe --version`
  - **macOS/Linux**：`runtime/bin/node --version`（注意是 `bin/` 前缀）
  输出 `v<版本>` 即成功。清理临时文件。

### 第 5 步：上报就绪状态

验证通过后调用 MCP 工具上报（GUI 重启后状态清空，需重新验证再报）：

```
plugin_set_status(name="nodejs", status="ready", detail={
  "version": "v22.x.x",
  "arch": "<win-x64|darwin-arm64|linux-x64|...>",
  "endpoint": "<实际命中的下载端点>",
  "verify": "node --version → v22.x.x"
})
```

下载/解压失败但目录已部分就位 → 报 `not_ready` + detail 写明卡在哪一步；
完全失败 → 报 `error` + detail 写明原因。

### 第 6 步：告知用户生效范围（⚠️ 平台差异要点）

- **Windows / macOS / Linux 三平台一致**：当前 AI 会话 Bash 直接 `node` / `npm` / `npx`
  均可用（GUI 推送 PATH→B 通道；新会话启动自扫 A 通道兜底）。
  三者由同一个 runtime 声明带来，无需为每个命令单独配置。
- **实现细节（备查）**：`aggregateRuntimePaths` 会注入 runtime 声明目录**及其 `bin/`
  子目录**（若存在）。这样两种发行版布局都能解析：
  - Windows 发行版把 `node.exe` 放在解压根 → 命中声明目录本身
  - mac/Linux 发行版按 Unix 惯例放 `bin/` → 命中 `<声明目录>/bin`
- ⚠️ **历史坑（2026-09-14 修）**：此前只注入声明目录、不加 `bin/`，于是 mac/Linux 上
  `node`/`npm`/`npx` 全部 `not found`。当时本文档把它记成了"macOS 已知限制 / 用绝对路径
  绕行"——**那是实现缺陷，不是平台限制**。它连带弄坏了 playwright-mcp
  （配置 `"command": "npx"` 解析不到；且即便用绝对路径跑 npx-cli.js，
  npx 子进程的 shebang `#!/usr/bin/env node` 仍会因 PATH 缺 node 而失败）。
  **若日后又见"必须写绝对路径"的说法，先查 PATH 聚合是否正常，别默认是平台限制。**
- 若当前会话 Bash 里 node 仍不可用：先重试一次，仍不行则告知用户重启会话/引擎后生效。

## npm / npx 与依赖安装

### 三个命令的关系（npm 不是二进制）

runtime 根目录同时提供三个命令，**由同一个 PATH 条目带来**（注入单位是目录，不是文件）——
不需要为 npm/npx 单独加 PATH：

| 命令 | 实体 | 说明 |
|------|------|------|
| `node` | `runtime/node.exe`（Win）/ `runtime/bin/node` | 唯一的二进制，Node 本体 |
| `npm` | `runtime/npm`（bash 包装器）/ `npm.cmd`（批处理）/ `npm.ps1` | 包装器脚本 |
| `npx` | 同上，同目录的另一个包装器 | 同上 |

包装器不是实现，真正的 npm 是 `runtime/node_modules/npm/bin/npm-cli.js`（**纯 JS，必须由 node 执行**）。

**AI 调 npm 时用的是插件 runtime 的 node**（与系统 Node 无关）：包装器逻辑是
`NODE_EXE="$basedir/node.exe"`——优先用**和自己同目录**的 node.exe，没有才回落 PATH 里的 node。
`npm config get prefix` 返回 `<插件目录>/nodejs/runtime` 即可验证（prefix 默认 = node 所在目录）。

### 装依赖：两种模式（多插件同包不同版本都不会冲突）

1. **本地依赖** `cd <插件目录> && npm install <pkg>` → 落到该插件自己的 `node_modules/`。
   Node 解析规则是「从脚本所在目录向上找 node_modules」，每个插件先命中自己那份 ——
   实测两个插件各用同包不同版本可并存、各自解析。
2. **npx 模式** `npx <pkg>`（生态推荐，playwright-mcp 即此模式）→ 落到 npx 共享缓存
   `%LOCALAPPDATA%/npm-cache/_npx/<哈希>/`（mac/Linux `~/.npm/_npx/`）。
   目录名是包集合的哈希：不同版本/组合各自独立，**相同**版本自动复用（省磁盘）。

⚠️ **不要在 `<plugins 根>/` 里 `npm install`** —— 该位置的 `node_modules` 处于解析链第 2 位，
会成为**所有插件**的共享 fallback，多插件版本冲突正是从这来。装依赖一律进具体插件目录。

### 全局安装（`npm install -g`）：默认落点会丢包

npm 的 `prefix` 默认 = **node 所在目录** → 在插件 runtime 里就是
`<插件目录>/nodejs/runtime`。所以默认 `-g` 会把包装进 **runtime 内部**：

- 插件**更新或卸载**时整个插件目录被清空 → 全局包随之丢失
- 也污染 runtime（那是"安装产物"目录，不该混入用户包）

**推荐做法**——`--prefix` 指到插件目录之外。Windows 上 `%APPDATA%/npm` 已在系统 PATH
（Node 安装器预留），装完**直接可用、无需任何额外参数**：

```bash
# Windows
npm install -g <pkg> --prefix "$APPDATA/npm"     # 之后 which <pkg> 直接命中
```

```bash
# macOS/Linux：指到用户级目录，并确保其 bin 在 PATH（该平台无预置条目）
npm install -g <pkg> --prefix ~/.local           # 需自行确保 ~/.local/bin 在 PATH
```

> 外部目录装的 CLI 靠 PATH 里的 `node` 运行 → 依赖本插件可用。卸载 nodejs 后
> 这些 CLI 会因找不到 node 而失效（合理依赖，但需如实告知用户）。
>
> 落点仍受平台差异影响：**Windows** 一切直接可用；**macOS/Linux** 因 PATH 注入的是
> runtime 根（非 `runtime/bin/`，见第 6 步），npm 本身就要用绝对路径调用：
> `<runtime>/bin/npm`。

## 故障模式与诊断

### 1. 「装了但 AI Bash 里 node 不可用」
- 先 `plugin_list` 看插件在列且 `enabled: true`、`aiStatus` 是否为 `ready`；
- `aiStatus` 缺失 → 环境安装未完成或未上报——从第 1 步重走；
- **Windows**：`runtime/node.exe` 存在但 Bash 不可用 → 当前会话可能是推送前启动的旧引擎——
  让用户重启会话（通道 A 兜底会在启动时注册）。
- **macOS/Linux**：`runtime/bin/node` 存在但 `node` 不可用 → **预期行为**（见第 6 步），
  改用绝对路径；若绝对路径也不可执行 → 检查 `chmod +x`（tar 解压可能丢执行位）。

### 2. 「下载一直失败」
- 按 fallback 链逐级试过没有？三端点都失败通常是网络层问题（代理/防火墙）；
- 检查临时目录有无残留截断文件（< 10MB）→ 清掉重试；
- 让用户手动下载并告知路径 → 你来解压拍平（下载是唯一允许用户介入的步骤）。

### 3. 「解压后 node 不在 runtime/ 根」
- **Windows**：多套了一层目录（`runtime/node-v22.x-win-x64/node.exe`）→ 把内层内容上移一层。
- **macOS/Linux**：`runtime/bin/node` 不在 → 检查是否多套了一层（应解压出
  `bin/`、`lib/`、`include/` 等目录直接在 runtime/ 下）。

### 4. 「插件进程里 node 可用性异常」
- 依赖插件的进程 PATH 由平台在 spawn 时注入（前置段）——`plugin_get` 看该插件
  processes 声明；进程 error 时看 Worker 面板状态与日志。

### 5. 「卸载被拒绝」
- 卸载 nodejs 前必须先卸载依赖它的插件（GUI 会列出清单）——这是防呆设计不是故障。

### 6. 「npm 全局装的 CLI 突然失效 / 找不到」
- 先看它装在哪：`npm config get prefix` 返回 `<插件目录>/nodejs/runtime` 即中招 ——
  默认 `-g` 落点就在 runtime 内，插件更新/卸载会清空该目录。
- 修复：重装并显式指定外部位置（`--prefix`，见「全局安装」节），之后不再受插件生命周期影响。
- 若 CLI 在但**执行报错**（找不到 node）→ 它依赖 PATH 里的 `node`，先确认 node 可用（第 6 步）。

### 7. 「npm 命令行为怪异 / 版本错乱」（罕见）
- 包装器的回落逻辑是「同目录有 node.exe 就用它，否则用 PATH 的 node」。
  若 `runtime/node.exe` 因异常中断被删、而包装器仍在，会出现
  **「插件的 npm + 系统的 node」混合态** → 表现为版本错乱或诡异报错。
- 修复：重走第 3-4 步补齐 runtime（或直接重新解压已下载的包）。

## 日志与状态位置

- 安装目录：`%APPDATA%/com.claudecode.gui/plugins/nodejs/`（Win）/
  `~/Library/Application Support/com.claudecode.gui/plugins/nodejs/`（mac）/
  `~/.config/com.claudecode.gui/plugins/nodejs/`（Linux）
- 运行时就绪标记：`plugin_get name=nodejs` 的 `aiStatus` 字段（内存态，GUI 重启清空）
- 下载临时区：`%TEMP%/nodejs-plugin-download/`（Win）/ `/tmp/nodejs-plugin-download/`（unix）——装完即清

## 配置依赖

- dependencies: 无
- installType: ai-guided——**卸载指导**：直接调 `plugin_uninstall`（用户同意后），
  Node 运行时在 runtime/ 内随目录一起删除，无系统残留
- **`needsRestart: true`** —— ⚠️ 卸载后**要问用户是否重启**（见下）
- platforms: ["windows","macos","linux"]
- 版本兼容：跟随 LTS；本插件不管理多版本（将来如需，按 nodejs20/nodejs22 拆分插件）

### ⚠️ 卸载后必须提示用户重启（`needsRestart` 的由来）

本插件的 runtime 被**注入到运行中的进程与会话的 PATH** 里（插件进程 + AI Bash）。
卸载后那些**已经跑起来的**进程，PATH 仍指向已被删除的 `plugins/nodejs/runtime/`：

- 表现为 `node` 命令"回落到系统安装"，而不是干净地"这个插件没了"
- 若系统本来没装 Node → 表现为 `node: command not found`（而插件明明卸载成功了）

所以卸载完成后，`plugin_uninstall` 的返回值会带 `needsRestart: true` 与说明 ——
**你要据此询问用户**是否现在重启（用户同意后再调 `app_relaunch` 带 `confirm:true`）。
用户拒绝也完全可以（那就下次自己重启），但**必须如实告知**这一点。
