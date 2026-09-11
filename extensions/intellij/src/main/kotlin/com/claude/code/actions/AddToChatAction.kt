package com.claude.code.actions

import com.claude.code.ClaudeCodeService
import com.google.gson.Gson
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile

/**
 * Adds selected files/folders from Project View to Claude Code chat.
 *
 * Mirrors VS Code extension.ts:193-212 (claude-code.addToChat command)
 * and VS 2022 AddToChatCommand.cs.
 *
 * Sends {type: 'file_picked', files: [{path, language?, isDir?}]} to the webview,
 * then shows the tool window.
 */
class AddToChatAction : AnAction() {

    private val gson = Gson()

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY) ?: return
        if (files.isEmpty()) return

        val fileList = files.map { vf ->
            val relativePath = VfsUtil.getRelativePath(vf, project.baseDir) ?: vf.path
            val map = mutableMapOf<String, Any?>(
                "path" to relativePath
            )
            if (vf.isDirectory) {
                map["isDir"] = true
            } else {
                val ext = vf.extension ?: ""
                if (ext.isNotEmpty()) map["language"] = ext.lowercase()
            }
            map
        }

        val payload = mapOf(
            "type" to "file_picked",
            "files" to fileList
        )

        val service = project.getService(ClaudeCodeService::class.java)
        service.bridge?.sendToWebview(gson.toJson(payload))
        showToolWindow(project)
    }

    private fun showToolWindow(project: com.intellij.openapi.project.Project) {
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager
            .getInstance(project)
            .getToolWindow("Claude Code")
        toolWindow?.show()
    }
}
