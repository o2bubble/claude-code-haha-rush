package com.claude.code.toolwindow

import com.claude.code.ClaudeCodeService
import com.claude.code.ContextProvider
import com.claude.code.MessageRouter
import com.claude.code.ModelProfileManager
import com.claude.code.ProcessManager
import com.claude.code.webview.WebviewBridge
import com.claude.code.webview.WebviewHtmlBuilder
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.awt.BorderLayout
import java.io.File
import javax.swing.JPanel

/**
 * Creates the Claude Code tool window with an embedded JCEF browser.
 * Mirrors VS Code provider.ts:resolveWebviewView() (lines 399-583).
 */
class ClaudeCodeToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // Already on the EDT — IntelliJ calls ToolWindowFactory from the event dispatch thread
        createBrowserPanel(project, toolWindow)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true

    // ── internal ─────────────────────────────────────────────────────────

    private fun createBrowserPanel(project: Project, toolWindow: ToolWindow) {
        val service = project.service<ClaudeCodeService>()

        // 1. Find the claude-ide script (mirrors VS Code extension.ts:57-89)
        val scriptPath = findIdeScript(project)
        service.ideScriptPath = scriptPath
        val workspacePath = project.basePath

        // 2. Create the JCEF browser (createImmediately required for executeJavaScript to work)
        val browser = JBCefBrowser()
        browser.createImmediately()

        // 3. Create and init the bridge BEFORE building HTML.
        //    bridge.init() calls WebviewHtmlBuilder.setBridgeJs() which embeds
        //    window.sendToJava into the HTML template.
        val bridge = WebviewBridge(browser) { json ->
            service.messageRouter?.handleFromWebview(json)
        }
        bridge.init()

        // 4. Build the HTML (now bridge JS is already set)
        val language = com.claude.code.settings.ClaudeCodeSettings.getInstance().language
        val html = WebviewHtmlBuilder.build(language)

        // 5. Load HTML
        browser.loadHTML(html)

        // 6. Create ModelProfileManager, restore saved profile (Phase 4)
        val modelProfileManager = ModelProfileManager(scriptPath, workspacePath)
        modelProfileManager.restoreIdeProfile()

        // 7. Create ProcessManager and MessageRouter (Phase 3)
        val processManager = ProcessManager(scriptPath, workspacePath)
        val messageRouter = MessageRouter(project, bridge, processManager, modelProfileManager)
        messageRouter.start()

        service.browser = browser
        service.bridge = bridge
        service.processManager = processManager
        service.messageRouter = messageRouter
        service.modelProfileManager = modelProfileManager

        // 7. Wrap in panel and add to tool window
        val panel = JPanel(BorderLayout())
        panel.add(browser.component, BorderLayout.CENTER)

        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)

        // 9. Create ContextProvider for auto IDE context (Phase 5)
        val contextProvider = ContextProvider(
            project = project,
            sendToWebview = { json -> bridge.sendToWebview(json) },
            sendToBackend = { json -> processManager.send(json) },
            enabled = { true },  // TODO: read from settings
            maxFiles = { 5 }     // TODO: read from settings
        )

        // 10. Start the backend process AFTER the webview is loaded
        // (mirrors VS Code: processManager.start() called in resolveWebviewView)
        processManager.start()
    }

    // ── Find IDE Script (mirrors VS Code extension.ts:57-89) ────────────

    /**
     * 4-tier search for claude-ide script:
     * 1. User-configured cliPath setting → $cliPath/bin/claude-ide.cmd
     * 2. Extension install location → ../../bin/claude-ide.cmd
     * 3. Project workspace root → $projectRoot/bin/claude-ide.cmd
     * 4. System PATH
     */
    private fun findIdeScript(project: Project): String {
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        val ideScript = if (isWindows) "claude-ide.cmd" else "claude-ide"

        // Priority 1: User-configured cliPath setting (Phase 4 will read from config)
        // For now, skip and fall through

        // Priority 2: Extension install location
        val extRoot = try {
            val url = javaClass.classLoader.getResource("META-INF/plugin.xml")
            if (url != null) {
                // In dev: .../build/resources/main/META-INF/plugin.xml
                // In prod: .../lib/claude-code-ide.jar!/META-INF/plugin.xml
                var path = url.path.removeSuffix("/META-INF/plugin.xml")
                if (path.startsWith("/") && path.length > 2 && path[2] == ':') {
                    path = path.substring(1)
                }
                File(path).resolve("../../bin/$ideScript")
            } else null
        } catch (_: Exception) { null }
        if (extRoot != null && extRoot.exists()) return extRoot.absolutePath

        // Priority 3: Project workspace root
        val projectRoot = project.basePath
        if (projectRoot != null) {
            val fromProject = File(projectRoot, "bin/$ideScript")
            if (fromProject.exists()) return fromProject.absolutePath
        }

        // Priority 4: System PATH
        val pathEnv = System.getenv("PATH") ?: System.getenv("Path") ?: ""
        for (dir in pathEnv.split(File.pathSeparator)) {
            if (dir.isBlank()) continue
            val fromPath = File(dir, ideScript)
            if (fromPath.exists()) return fromPath.absolutePath
        }

        throw RuntimeException(
            "Cannot find $ideScript. Set claudeCode.cliPath in Settings → Tools → Claude Code."
        )
    }

    // ── Resource Root Resolution ────────────────────────────────────────

    private fun resolveResourceRoot(): String {
        val url = javaClass.classLoader.getResource("webview/template.html")
        if (url != null) {
            var path = url.path
            if (path.startsWith("/") && path.length > 2 && path[2] == ':') {
                path = path.substring(1)
            }
            val idx = path.lastIndexOf("webview/template.html")
            if (idx >= 0) {
                return path.substring(0, idx)
            }
        }
        val projectBase = System.getProperty("user.dir") ?: "."
        return "$projectBase/src/main/resources"
    }
}
