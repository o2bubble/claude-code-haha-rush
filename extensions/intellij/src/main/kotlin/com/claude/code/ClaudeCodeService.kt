package com.claude.code

import com.claude.code.webview.WebviewBridge
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser

/**
 * Project-level service: one Claude Code backend process per open project.
 *
 * Mirrors the combined roles of VS Code extension.ts (lifecycle + commands)
 * and VS 2022 ClaudeChatWindowControl.xaml.cs (message routing + backend).
 *
 * Implements Disposable so the backend process is killed when the project
 * closes — equivalent to VS Code's context.subscriptions.push({ dispose() })
 * in extension.ts:303.
 */
@Service(Service.Level.PROJECT)
class ClaudeCodeService(private val project: Project) : Disposable {

    var browser: JBCefBrowser? = null
    var bridge: WebviewBridge? = null
    var processManager: ProcessManager? = null
    var messageRouter: MessageRouter? = null
    var modelProfileManager: ModelProfileManager? = null
    var ideScriptPath: String? = null

    override fun dispose() {
        processManager?.stop()
        browser = null
        bridge = null
        processManager = null
        messageRouter = null
        modelProfileManager = null
    }

    companion object {
        fun getInstance(project: Project): ClaudeCodeService {
            return project.getService(ClaudeCodeService::class.java)
        }
    }
}
