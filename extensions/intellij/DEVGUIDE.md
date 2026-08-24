# IntelliJ Platform 插件开发心得

本文档记录将 Claude Code IDE 插件移植到 IntelliJ Platform 的完整过程，包括资料、环境、打包、调试。

---

## 一、参考资料

### 官方文档（必读）

| 文档 | 链接 |
|------|------|
| IntelliJ Platform Plugin SDK (主入口) | https://plugins.jetbrains.com/docs/intellij |
| Tool Windows | https://plugins.jetbrains.com/docs/intellij/tool-windows.html |
| Actions (菜单/右键/快捷键) | https://plugins.jetbrains.com/docs/intellij/plugin-actions.html |
| JCEF (内嵌浏览器) | https://plugins.jetbrains.com/docs/intellij/jcef.html |
| Services (插件服务) | https://plugins.jetbrains.com/docs/intellij/plugin-services.html |
| Extension Points | https://plugins.jetbrains.com/docs/intellij/plugin-extension-points.html |
| Settings (配置页) | https://plugins.jetbrains.com/docs/intellij/settings-tutorial.html |
| Persistent State (持久化) | https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html |
| Gradle Plugin 2.x | https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html |
| 插件发布 | https://plugins.jetbrains.com/docs/intellij/publishing-plugin.html |

### 关键参考

- **jetbrains-cc-gui** (GitHub: zhukunpenglinyutong/jetbrains-cc-gui) — 成熟的第三方 Claude Code JetBrains 插件，JCEF 桥接实现的生产级参考
- **IntelliJ SDK Code Samples** (GitHub: JetBrains/intellij-sdk-code-samples) — 官方示例集
- **IntelliJ Platform Plugin Template** (GitHub: JetBrains/intellij-platform-plugin-template) — 项目模板

### 社区问题

JetBrains 官方社区论坛：https://platform.jetbrains.com/

搜索问题时常用的关键词：
- `JBCefBrowser` — JCEF 浏览器组件
- `JBCefJSQuery` — JS → Kotlin 通信回调
- `ToolWindowFactory` — 工具窗口工厂
- `toolWindow extension point` — plugin.xml 中注册工具窗口

---

## 二、环境搭建

### 需要的工具

1. **JDK 21** — IntelliJ 2025.1+ 要求
2. **Gradle 8.x+** (用 Wrapper，不需要全局安装)
3. **IntelliJ IDEA** (Community 版即可) — 用于开发和 `runIde` 调试
4. **一台 Windows/macOS/Linux 机器** — 能跑 IntelliJ IDE

### WSL 打包环境 (Windows)

```bash
# WSL 中安装 JDK 21
sudo apt install openjdk-21-jdk

# Gradle Wrapper 会自举，但也可以预先安装全局版本
# 下载 gradle-9.0.0-bin.zip 解压到 /opt/
# export PATH=/opt/gradle-9.0.0/bin:$PATH
```

### 生成 Gradle Wrapper

```bash
cd extensions/intellij
gradle wrapper --gradle-version 9.0.0
```

### 项目导入 IntelliJ IDEA

1. File → Open → 选择 `extensions/intellij/` 目录
2. IDEA 识别为 Gradle 项目 → 自动下载依赖
3. 右侧 Gradle 面板 → 所有 task 出现

### 离线/加速下载 (中国地区)

在 `build.gradle.kts` 中添加阿里云 Maven 镜像：
```kotlin
repositories {
    maven { url = uri("https://maven.aliyun.com/repository/central") }
    maven { url = uri("https://maven.aliyun.com/repository/public") }
    mavenCentral()
    // ...
}
```

在 `gradle/wrapper/gradle-wrapper.properties` 中使用腾讯云镜像：
```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-9.0.0-bin.zip
```

---

## 三、项目结构

```
extensions/intellij/
├── build.gradle.kts              # 构建脚本 (IntelliJ Platform Gradle Plugin 2.x)
├── settings.gradle.kts           # 项目名
├── gradle.properties             # 平台版本、JVM 参数
├── gradle/wrapper/               # Gradle Wrapper
├── src/main/
│   ├── kotlin/com/claude/code/
│   │   ├── ClaudeCodeService.kt          # Project 级 Service (总控)
│   │   ├── ProcessManager.kt             # 后端进程管理 + WebSocket
│   │   ├── MessageRouter.kt              # 前端 ↔ 后端消息路由
│   │   ├── ModelProfileManager.kt        # 模型 Profile 管理
│   │   ├── ContextProvider.kt            # IDE 上下文自动采集
│   │   ├── toolwindow/
│   │   │   └── ClaudeCodeToolWindowFactory.kt  # ToolWindow 工厂
│   │   ├── webview/
│   │   │   ├── WebviewBridge.kt          # JCEF JS↔Kotlin 桥接
│   │   │   └── WebviewHtmlBuilder.kt     # HTML 内联构建
│   │   ├── actions/
│   │   │   ├── SendSelectionAction.kt    # 发送选中文本
│   │   │   └── AddToChatAction.kt        # 添加文件到对话
│   │   └── settings/
│   │       ├── ClaudeCodeSettings.kt     # PersistentStateComponent
│   │       └── ClaudeCodeConfigurable.kt # Settings UI
│   └── resources/
│       ├── META-INF/plugin.xml           # 插件描述文件
│       ├── webview/                      # 前端 (从 VS Code 复制)
│       └── media/fontawesome/            # 图标字体
```

---

## 四、打包

### 命令行

```bash
cd extensions/intellij
./gradlew buildPlugin
```

产物：`build/distributions/claude-code-ide-0.1.0-SNAPSHOT.zip`

### 关键 Gradle Tasks

| Task | 用途 |
|------|------|
| `./gradlew buildPlugin` | 构建插件 zip |
| `./gradlew runIde` | 启动沙箱 IDE 测试插件 |
| `./gradlew compileKotlin` | 只编译 Kotlin (快速查错) |
| `./gradlew clean` | 清空构建缓存 |

### 版本兼容性

`build.gradle.kts` 中的三个关键版本要对应：
```kotlin
intellijIdeaCommunity("2025.1.4")  // 目标 IDE 版本
ideaVersion { sinceBuild = "251" }  // 最低兼容 build 号
```
PyCharm 251.28774.16 对应 2025.1.x，所以 `sinceBuild = "251"`。

---

## 五、调试

### 5.1 开发模式 (runIde)

```bash
./gradlew runIde
```

启动一个沙箱 IDE，插件自动加载。热重载需要重新 runIde（不支持代码热替换）。

### 5.2 JCEF Chrome DevTools (最重要！)

1. PyCharm/IDEA → Help → Edit Custom VM Options，加一行：
   ```
   -Dide.browser.jcef.debug.port=9222
   ```
2. 重启 IDE
3. 打开插件 ToolWindow
4. Chrome 访问 `http://localhost:9222` → 选择 JCEF 页面 → Console 标签

**这个调试工具是无价的。** 绑定 bridge 通信问题、JS 报错、CSP 拦截，都能在 Console 直接看到。

### 5.3 查看 IDEA 日志

```
Help → Show Log in Explorer → idea.log
```

搜索我们的日志输出：
```bash
grep -a "ClaudeCode" idea.log
```

我们的 `println("[ClaudeCode] ...")` 会输出到 `STDOUT` 标记的行。
`System.err` 会输出到 `STDERR` 标记的行。

### 5.4 常见踩坑

#### (1) `invokeAndWait` from EDT

`ToolWindowFactory.createToolWindowContent()` 已经在 EDT 上执行，不能再 `SwingUtilities.invokeAndWait`。直接用即可。

#### (2) `getResourceAsStream()` vs `File.readText()`

插件安装后资源在 JAR 包内，`new File("webview/template.html")` 找不到文件。
**必须用**：
```kotlin
javaClass.classLoader.getResourceAsStream("webview/template.html")
```

#### (3) JBCefJSQuery 注入时机

`JBCefJSQuery` 必须在 `loadHTML()` 之前创建，但桥接 JS 必须在 HTML 加载后执行。
**最佳实践**：把 `window.sendToJava` 通过 `WebviewHtmlBuilder` 直接嵌入 HTML，
避免使用 `executeJavaScript()` 事后注入。（本次开发中踩的最深的坑）

#### (4) `sinceBuild` 和 IDE 版本映射

| IDE 版本 | Build 号前缀 | sinceBuild |
|----------|-------------|------------|
| 2025.1.x | 251 | `"251"` |
| 2025.2.x | 252 | `"252"` |
| 2025.3.x | 253 | `"253"` |

PyCharm 的 build 号格式：`PY-251.28774.16`，去掉 `PY-` 前面的字母就是版本。

#### (5) IntelliJ 线程模型

所有 UI 操作（Editor, PSI, VirtualFile）必须在 **EDT** 或 **Read Action** 中执行：
```kotlin
// 读操作
val result = ApplicationManager.getApplication().runReadAction<Type> { ... }

// 写操作
ApplicationManager.getApplication().runWriteAction { ... }
```

我们的 `ContextProvider` 的 Timer 线程触发了读操作，必须包在 `runReadAction` 里。

#### (6) Gradle 版本

IntelliJ Platform Gradle Plugin 2.14.0+ 要求 Gradle 9.0.0+。
如果全局 Gradle 版本太旧，先用一个空白 `build.gradle` 生成 Wrapper。

#### (7) 通过 WSL 打包

Windows Git Bash 的 PATH 中的 `Program Files (x86)` 括号会导致 bash 语法错误。
解决方法：在 WSL 脚本中设置最小化 PATH：
```bash
export PATH=/opt/gradle-9.0.0/bin:/usr/bin:/bin
```

---

## 六、架构关键决策

### 为什么 JCEF (而不是 WebView2)

- IntelliJ Platform 基于 JVM/Swing，内嵌 Chromium 只能通过 JCEF
- JBCefBrowser 是 JCEF 的 IntelliJ 封装，与 ToolWindow/Swing 原生集成
- WebView2 是 COM/Win32 组件，无法跨平台，也无法嵌入 JVM UI

### 为什么 Kotlin (而不是 Java)

- IntelliJ Platform SDK 官方推荐 Kotlin，DSL 语法简洁（如 `panel { group { row { } } }`）
- 空安全、数据类、扩展函数都极大简化插件开发

### 为什么 Project Service

- Claude Code 后端是按项目启动的（`--cwd` 参数 = 项目目录）
- Project Service 生命周期 = 项目打开/关闭，完美匹配
- 多个项目同时打开时，每个有独立的后端进程

### 前端复用策略

- `media/webview/` 下 30+ 个 JS/CSS/HTML 文件直接从 VS Code 插件复制，**零修改**
- 唯一的适配层：HTML 中注入 `window.sendToJava` (JBCefJSQuery) + `acquireVsCodeApi` shim
- 对前端代码来说，它感知不到自己在 VS Code 还是在 IntelliJ 里运行

---

## 七、开发节奏建议

1. **第一阶段**：ToolWindow + JBCefBrowser + 加载本地 HTML → 确认 UI 能渲染
2. **第二阶段**：JBCefJSQuery 双向通信 + Chrome DevTools 验证
3. **第三阶段**：后端进程启动 + WebSocket 连接
4. **第四阶段**：模型 Profile + 会话管理
5. **第五阶段**：IDE Context 采集 + 编辑器/右键集成
6. **每个阶段结束后**：对照 VS Code 插件源码逐行检查逻辑是否一致

前端 UI 问题调试优先级：
1. **前置**: Help → Edit Custom VM Options → 加 `-Dide.browser.jcef.debug.port=9222` → 重启 IDE
2. `http://localhost:9222` Chrome DevTools → Console 看 JS 报错
3. `idea.log` 搜索 `ClaudeCode` 看 Kotlin 日志
4. `./gradlew compileKotlin` 查编译错误
