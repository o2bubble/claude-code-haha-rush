package com.claude.code.actions

import com.claude.code.ClaudeCodeService
import com.google.gson.Gson
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.VfsUtil

/**
 * Sends the entire current file to Claude Code chat.
 *
 * Mirrors VS Code extension.ts:173-191 (claude-code.sendFile command).
 *
 * Sends {type: 'file_picked', files: [{path, content, language}]} to the webview,
 * then shows the tool window.
 */
class SendFileAction : AnAction() {

    private val gson = Gson()

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.project ?: return
        val doc = editor.document
        val vf = FileDocumentManager.getInstance().getFile(doc) ?: return

        val filePath = VfsUtil.getRelativePath(vf, project.baseDir) ?: vf.path
        val ext = vf.extension ?: ""
        val content = doc.text

        val payload = mapOf(
            "type" to "file_picked",
            "files" to listOf(
                mapOf(
                    "path" to filePath,
                    "content" to content,
                    "language" to ext.lowercase()
                )
            )
        )

        val service = project.getService(ClaudeCodeService::class.java)
        service.bridge?.sendToWebview(gson.toJson(payload))
        showToolWindow(project)
    }

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor != null
    }

    private fun showToolWindow(project: com.intellij.openapi.project.Project) {
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager
            .getInstance(project)
            .getToolWindow("Claude Code")
        toolWindow?.show()
    }
}
