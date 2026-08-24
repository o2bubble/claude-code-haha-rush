package com.claude.code

import com.claude.code.webview.WebviewBridge
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.project.Project

/**
 * Routes messages between the webview frontend and the Claude Code backend
 * process. Handles all message types documented in protocol.ts.
 *
 * Mirrors:
 *   VS Code extension.ts:240-265  — backend message listener
 *   VS Code provider.ts:416-568   — webview message handler (switch case)
 *   VS 2022 ClaudeChatWindowControl.xaml.cs:ProcessMessage()
 *
 * Architecture:
 *   WebView JS → WebviewBridge → MessageRouter → ProcessManager (WebSocket) → Backend
 *   Backend → ProcessManager (WebSocket) → MessageRouter → WebviewBridge → WebView JS
 */
class MessageRouter(
    private val project: Project,
    private val bridge: WebviewBridge,
    private val processManager: ProcessManager,
    private val modelProfileManager: ModelProfileManager
) {
    private val gson = Gson()

    // ── Start routing ───────────────────────────────────────────────────

    /**
     * Wire up all message paths. Call once after all components are created.
     */
    fun start() {
        // Messages from backend → webview
        processManager.onMessage = { json ->
            bridge.sendToWebview(json)

            // Reset restart count on successful completion
            val root = tryParse(json)
            if (root != null && root.has("type") && root.has("subtype")) {
                val type = root.get("type")?.asString
                val subtype = root.get("subtype")?.asString
                if (type == "result" && subtype == "success") {
                    processManager.resetRestartCount()
                }
            }
        }

        processManager.onLog = { log ->
            println("[ClaudeCode] $log")
            bridge.appendLog(log)
        }

        processManager.onStatus = { status, data ->
            val msg = mutableMapOf<String, Any?>("type" to "status", "status" to status)
            if (data != null) msg.putAll(data)
            bridge.sendToWebview(gson.toJson(msg))
        }

        processManager.onError = { error ->
            println("[ClaudeCode] ERROR: $error")
        }
    }

    /**
     * Handle a message from the webview frontend.
     * Called by WebviewBridge's onMessageFromJs callback.
     *
     * Mirrors VS Code provider.ts:416-568 (onDidReceiveMessage switch case).
     */
    fun handleFromWebview(json: String) {
        val root = tryParse(json) ?: return
        val type = root.get("type")?.asString ?: return

        when (type) {
            // ── Ready ───────────────────────────────────────────────────
            "ready" -> {
                // Queue flushing handled by WebviewBridge internally.
                // Send workspace files for @-mention autocomplete
                sendWorkspaceFiles()
                // Send model profiles list
                val profilesJson = modelProfileManager.getModelProfilesJson()
                bridge.sendToWebview(profilesJson)
            }

            // ── User messages → backend ─────────────────────────────────
            "user_message" -> {
                val content = root.get("content")?.asString ?: return
                val attachments = root.get("attachments")
                val msg = mutableMapOf<String, Any?>(
                    "type" to "user",
                    "message" to mapOf("role" to "user", "content" to content),
                    "parent_tool_use_id" to null
                )
                if (attachments != null) {
                    // Parse attachments array and include
                    msg["attachments"] = gson.fromJson(attachments, List::class.java)
                }
                processManager.send(gson.toJson(msg))
            }

            // ── Permission response → backend ───────────────────────────
            "control_response" -> {
                val requestId = root.get("request_id")?.asString ?: return
                val allowed = root.get("allowed")
                val session = root.get("session")
                val always = root.get("always")
                val reason = root.get("reason")
                val updatedInput = root.get("updatedInput")

                val response = mutableMapOf<String, Any?>()
                if (allowed != null && allowed.isJsonPrimitive) response["allowed"] = allowed.asBoolean
                if (session != null && session.isJsonPrimitive) response["session"] = session.asBoolean
                if (always != null && always.isJsonPrimitive) response["always"] = always.asBoolean
                if (reason != null) response["reason"] = reason.asString
                if (updatedInput != null) response["updatedInput"] = updatedInput

                val msg = mapOf(
                    "type" to "control_response",
                    "request_id" to requestId,
                    "response" to response
                )
                processManager.send(gson.toJson(msg))
            }

            // ── Session management → backend ────────────────────────────
            "list_sessions"   -> processManager.send(json)
            "load_session"    -> processManager.send(json)
            "resume_session"  -> processManager.send(json)
            "delete_session"  -> processManager.send(json)
            "rename_session"  -> processManager.send(json)
            "new_session"     -> processManager.send(json)
            "pin_session"     -> processManager.send(json)

            // ── Task management → backend ───────────────────────────────
            "list_tasks"      -> processManager.send(json)
            "kill_task"       -> processManager.send(json)

            // ── Permission mode → backend ───────────────────────────────
            "set_permission_mode" -> processManager.send(json)

            // ── Misc → backend ──────────────────────────────────────────
            "interrupt"       -> processManager.send(json)
            "compact"         -> processManager.send(json)
            "side_question"   -> processManager.send(json)
            "list_rewind_points" -> processManager.send(json)
            "execute_rewind"  -> processManager.send(json)

            // ── Model profiles ──────────────────────────────────────────
            "request_model_profiles" -> {
                val profilesJson = modelProfileManager.getModelProfilesJson()
                bridge.sendToWebview(profilesJson)
            }
            "set_model_profile" -> {
                // Accept both "profile" (VS Code) and "profileId" (VS 2022 compat)
                val profileId = root.get("profile")?.asString
                    ?: root.get("profileId")?.asString
                    ?: return

                val result = modelProfileManager.switchProfile(profileId)
                if (result != null) {
                    bridge.sendToWebview(result)
                }

                // Interrupt any in-progress turn before restarting
                processManager.send("""{"type":"interrupt"}""")

                // Restart backend with updated env (after short delay)
                Thread {
                    Thread.sleep(300)
                    processManager.restart()
                }.start()
            }

            // ── Quick commands ──────────────────────────────────────────
            "get_quick_cmds" -> {
                val qcPath = java.io.File(
                    System.getProperty("user.home"), ".claude/quick-cmds.json"
                )
                val commands = try {
                    if (qcPath.exists()) {
                        gson.fromJson(qcPath.readText(Charsets.UTF_8), List::class.java)
                    } else {
                        emptyList<Any>()
                    }
                } catch (_: Exception) {
                    emptyList<Any>()
                }
                val msg = gson.toJson(mapOf("type" to "quick_cmds_data", "commands" to commands))
                bridge.sendToWebview(msg)
            }
            "save_quick_cmds" -> {
                try {
                    val commands = root.get("commands")
                    val qcPath = java.io.File(
                        System.getProperty("user.home"), ".claude/quick-cmds.json"
                    )
                    qcPath.parentFile?.mkdirs()
                    qcPath.writeText(gson.toJson(commands), Charsets.UTF_8)
                    bridge.sendToWebview("""{"type":"quick_cmds_saved"}""")
                } catch (e: Exception) {
                    val err = gson.toJson(mapOf("type" to "quick_cmds_error", "error" to e.message))
                    bridge.sendToWebview(err)
                }
            }

            // ── File operations ──────────────────────────────────────────
            "open_file" -> {
                val rawPath = root.get("path")?.asString ?: return
                val path = if (java.io.File(rawPath).isAbsolute) rawPath
                    else java.io.File(project.basePath ?: ".", rawPath).absolutePath
                val vf = com.intellij.openapi.vfs.LocalFileSystem
                    .getInstance()
                    .findFileByPath(path)
                    ?: return
                com.intellij.openapi.fileEditor.FileEditorManager
                    .getInstance(project)
                    .openFile(vf, true)
            }
            "request_file_pick" -> {
                // Send workspace file tree for @-mention autocomplete
                sendWorkspaceFiles()
            }
            "request_file_content" -> {
                val filePath = root.get("path")?.asString ?: return
                val isDir = root.get("isDir")?.asBoolean ?: false
                handleFileContentRequest(filePath, isDir)
            }

            // ── Unknown ─────────────────────────────────────────────────
            else -> {
                println("[ClaudeCode] Unknown message type from webview: $type")
                // Still forward to backend in case it's a new type we don't recognize
                processManager.send(json)
            }
        }
    }

    // ── Workspace Files ─────────────────────────────────────────────────

    private var workspaceFileTreeCache: List<FileTreeNode>? = null
    private var workspaceFileTreeCacheTime: Long = 0
    private val fileTreeCacheMs = 60_000L

    /**
     * Collect workspace files and send the tree to the webview.
     * Mirrors VS Code provider.ts:207-227.
     */
    private fun sendWorkspaceFiles() {
        val now = System.currentTimeMillis()
        if (workspaceFileTreeCache != null && now - workspaceFileTreeCacheTime < fileTreeCacheMs) {
            val cached = gson.toJson(
                mapOf("type" to "workspace_files", "tree" to workspaceFileTreeCache)
            )
            bridge.sendToWebview(cached)
            return
        }

        try {
            val files = mutableListOf<String>()
            val baseDir = project.baseDir
            if (baseDir != null) {
                com.intellij.openapi.vfs.VfsUtil.iterateChildrenRecursively(
                    baseDir,
                    { vf ->
                        // Skip node_modules and hidden dirs
                        if (vf.isDirectory && (vf.name == "node_modules" || vf.name.startsWith("."))) {
                            return@iterateChildrenRecursively false
                        }
                        if (!vf.isDirectory) {
                            val relPath = com.intellij.openapi.vfs.VfsUtil
                                .getRelativePath(vf, baseDir) ?: vf.name
                            files.add(relPath)
                        }
                        files.size < 500 // max files
                    },
                    { true }
                )
            }

            val tree = buildFileTree(files)
            workspaceFileTreeCache = tree
            workspaceFileTreeCacheTime = now

            val msg = gson.toJson(mapOf("type" to "workspace_files", "tree" to tree))
            bridge.sendToWebview(msg)
        } catch (_: Exception) {
            bridge.sendToWebview("""{"type":"workspace_files","tree":[]}""")
        }
    }

    /**
     * Read a file or directory and send its content back.
     * Mirrors VS Code provider.ts:229-247.
     */
    private fun handleFileContentRequest(filePath: String, isDir: Boolean) {
        try {
            val baseDir = project.baseDir ?: return
            val vf = baseDir.findFileByRelativePath(filePath) ?: return

            if (isDir) {
                val names = vf.children?.map { it.name } ?: emptyList()
                val msg = gson.toJson(
                    mapOf("type" to "file_picked",
                        "files" to listOf(mapOf("path" to filePath, "content" to names.joinToString("\n"), "isDir" to true))
                    )
                )
                bridge.sendToWebview(msg)
                return
            }

            val content = String(vf.contentsToByteArray(), Charsets.UTF_8)
            val ext = filePath.substringAfterLast('.', "").lowercase()
            val msg = gson.toJson(
                mapOf("type" to "file_picked",
                    "files" to listOf(
                        mapOf(
                            "path" to filePath,
                            "content" to content,
                            "language" to ext
                        )
                    )
                )
            )
            bridge.sendToWebview(msg)
        } catch (_: Exception) {
            // File not readable — silently ignore
        }
    }

    /**
     * Build a sorted file tree from flat file paths.
     * Mirrors VS Code provider.ts:168-205.
     */
    private fun buildFileTree(files: List<String>): List<FileTreeNode> {
        data class BuilderNode(
            val name: String,
            val path: String,
            val isDir: Boolean,
            val children: MutableMap<String, BuilderNode>? = null
        )

        val root: MutableMap<String, BuilderNode> = mutableMapOf()
        for (file in files) {
            val parts = file.split("/")
            var current = root
            for (i in parts.indices) {
                val part = parts[i]
                val isDir = i < parts.size - 1
                val currentPath = parts.take(i + 1).joinToString("/")
                if (!current.containsKey(part)) {
                    current[part] = BuilderNode(
                        part, currentPath, isDir,
                        if (isDir) mutableMapOf() else null
                    )
                }
                if (isDir) {
                    current = current[part]!!.children!!
                }
            }
        }

        fun flatten(nodeMap: Map<String, BuilderNode>): List<FileTreeNode> {
            return nodeMap.entries
                .sortedWith(compareBy({ !it.value.isDir }, { it.key }))
                .map { (_, node) ->
                    FileTreeNode(
                        name = node.name,
                        path = node.path,
                        isDir = node.isDir,
                        children = if (node.children != null) flatten(node.children) else null
                    )
                }
        }

        return flatten(root)
    }

    data class FileTreeNode(
        val name: String,
        val path: String,
        val isDir: Boolean,
        val children: List<FileTreeNode>? = null
    )

    // ── Helpers ─────────────────────────────────────────────────────────

    private fun tryParse(json: String): JsonObject? {
        return try {
            val parsed = JsonParser.parseString(json)
            if (parsed.isJsonObject) parsed.asJsonObject else null
        } catch (_: Exception) {
            null
        }
    }
}
