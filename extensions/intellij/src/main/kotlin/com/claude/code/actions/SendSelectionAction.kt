package com.claude.code.actions

import com.claude.code.ClaudeCodeService
import com.google.gson.Gson
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.VfsUtil

/**
 * Sends the current editor selection to Claude Code chat.
 *
 * Mirrors VS Code extension.ts:152-170 (claude-code.sendSelection command).
 * Shortcut: Alt+Shift+L (matching VS Code keybinding).
 *
 * Sends {type: 'fill_input', text: "[file:line]", selection: {...}} to the webview,
 * then shows the tool window.
 */
class SendSelectionAction : AnAction() {

    private val gson = Gson()

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selectionModel = editor.selectionModel
        if (!selectionModel.hasSelection()) return

        val project = e.project ?: return
        val doc = editor.document
        val vf = FileDocumentManager.getInstance().getFile(doc) ?: return

        val filePath = VfsUtil.getRelativePath(vf, project.baseDir) ?: vf.path
        val startLine = doc.getLineNumber(selectionModel.selectionStart) + 1  // 1-based
        val endLine = doc.getLineNumber(selectionModel.selectionEnd) + 1
        val lineRef = if (startLine == endLine) "$startLine" else "$startLine-$endLine"

        val payload = mapOf(
            "type" to "fill_input",
            "text" to "[$filePath:$lineRef]",
            "selection" to mapOf(
                "filePath" to filePath,
                "startLine" to startLine,
                "endLine" to endLine
            )
        )

        val service = project.getService(ClaudeCodeService::class.java)
        service.bridge?.sendToWebview(gson.toJson(payload))
        showToolWindow(project)
    }

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible =
            editor != null && editor.selectionModel.hasSelection()
    }

    private fun showToolWindow(project: com.intellij.openapi.project.Project) {
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager
            .getInstance(project)
            .getToolWindow("Claude Code")
        toolWindow?.show()
    }
}
