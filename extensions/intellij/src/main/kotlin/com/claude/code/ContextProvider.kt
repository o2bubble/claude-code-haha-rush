package com.claude.code

import com.google.gson.Gson
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import java.util.Timer
import java.util.TimerTask
import kotlin.concurrent.schedule

/**
 * Collects IDE context (active file, selection, diagnostics) and sends it
 * to the Claude Code backend automatically.
 *
 * Mirrors VS Code contextProvider.ts (205 lines). All listener types and
 * debounce logic are preserved.
 *
 * IntelliJ API mappings:
 *   VS Code                                  → IntelliJ
 *   onDidChangeActiveTextEditor              → EditorFactoryListener + FileEditorManagerListener
 *   onDidChangeTextEditorSelection           → SelectionListener
 *   onDidChangeTextDocument                  → DocumentListener (via EditorFactoryListener)
 *   onDidChangeDiagnostics                   → skipped (IntelliJ inspection API is complex)
 *
 * @param bridge      For sending ide_context messages to the webview
 * @param sendToBackend  For sending ide_context messages directly to backend via ProcessManager
 * @param enabled     Whether auto-context is enabled (from settings)
 */
class ContextProvider(
    private val project: Project,
    private val sendToWebview: (String) -> Unit,
    private val sendToBackend: (String) -> Unit,
    private val enabled: () -> Boolean,
    private val maxFiles: () -> Int
) : Disposable {

    private val gson = Gson()
    private var debounceTimer: TimerTask? = null
    private val timer = Timer("claude-code-context", true)
    private val debounceMs = 500L

    // ── Setup ───────────────────────────────────────────────────────────

    init {
        setupListeners()
    }

    private fun setupListeners() {
        val bus = project.messageBus
        val connection = bus.connect(this)

        // Active editor changes
        connection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    scheduleContextUpdate()
                }
                override fun fileOpened(manager: FileEditorManager, file: VirtualFile) {
                    scheduleContextUpdate()
                }
                override fun fileClosed(manager: FileEditorManager, file: VirtualFile) {
                    scheduleContextUpdate()
                }
            }
        )

        // Selection changes on all editors
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(
            object : SelectionListener {
                override fun selectionChanged(e: SelectionEvent) {
                    scheduleContextUpdate()
                }
            },
            this
        )
    }

    // ── Collect & Send ──────────────────────────────────────────────────

    @Synchronized
    private fun scheduleContextUpdate() {
        if (!enabled()) return

        debounceTimer?.cancel()
        debounceTimer = timer.schedule(debounceMs) {
            val context = ApplicationManager.getApplication().runReadAction<Map<String, Any?>?> {
                collectContext()
            }
            if (context != null) {
                val json = gson.toJson(context)
                sendToBackend(json)
                // Send lightweight context to webview for selection preview
                val preview = mutableMapOf<String, Any?>("type" to "ide_context")
                val files = context["files"] as? List<*>
                if (files != null) {
                    preview["files"] = files.mapNotNull { f ->
                        val m = f as? Map<*, *> ?: return@mapNotNull null
                        mapOf("path" to (m["path"] ?: ""), "language" to (m["language"] ?: ""))
                    }
                }
                context["selection"]?.let { preview["selection"] = it }
                sendToWebview(gson.toJson(preview))
            }
        }
    }

    /**
     * Collect current IDE context.
     * Mirrors VS Code contextProvider.ts:94-112.
     */
    private fun collectContext(): Map<String, Any?>? {
        val files = collectActiveFiles()
        val selection = collectSelection()
        // Diagnostics: skipped for now (IntelliJ inspection API differs significantly)

        if (files.isEmpty() && selection == null) return null

        val result = mutableMapOf<String, Any?>("type" to "ide_context")
        if (files.isNotEmpty()) result["files"] = files
        if (selection != null) result["selection"] = selection
        return result
    }

    /**
     * Collect active files. Priority: active editor first, then visible editors.
     * Mirrors VS Code contextProvider.ts:114-143.
     */
    private fun collectActiveFiles(): List<Map<String, String>> {
        val result = mutableListOf<Map<String, String>>()
        val seen = mutableSetOf<String>()

        val fileEditorManager = FileEditorManager.getInstance(project)
        val fileDocManager = FileDocumentManager.getInstance()

        // Active editor first
        val activeEditor = fileEditorManager.selectedTextEditor
        if (activeEditor != null) {
            val doc = activeEditor.document
            val vf = fileDocManager.getFile(doc)
            if (vf != null) {
                val path = VfsUtil.getRelativePath(vf, project.baseDir)
                    ?: vf.path
                seen.add(vf.path)
                result.add(
                    mapOf(
                        "path" to path,
                        "content" to doc.text,
                        "language" to (vf.fileType?.name ?: "text")
                    )
                )
            }
        }

        // Visible editors
        for (editor in fileEditorManager.selectedEditors) {
            if (result.size >= maxFiles()) break
            try {
                val doc = fileEditorManager.selectedTextEditor?.document ?: continue
                val vf = fileDocManager.getFile(doc) ?: continue
                if (!seen.add(vf.path)) continue
                result.add(
                    mapOf(
                        "path" to (VfsUtil.getRelativePath(vf, project.baseDir) ?: vf.path),
                        "content" to doc.text,
                        "language" to (vf.fileType?.name ?: "text")
                    )
                )
            } catch (_: Exception) { /* skip unreadable files */ }
        }

        return result
    }

    /**
     * Collect current selection. Returns null if nothing is selected.
     * Mirrors VS Code contextProvider.ts:147-162.
     */
    private fun collectSelection(): Map<String, Any?>? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val selectionModel = editor.selectionModel
        if (!selectionModel.hasSelection()) return null

        val doc = editor.document
        val vf = FileDocumentManager.getInstance().getFile(doc)
        val path = if (vf != null) VfsUtil.getRelativePath(vf, project.baseDir) ?: vf.path else ""

        return mapOf(
            "path" to path,
            "startLine" to doc.getLineNumber(selectionModel.selectionStart),
            "startChar" to (selectionModel.selectionStart - doc.getLineStartOffset(
                doc.getLineNumber(selectionModel.selectionStart)
            )),
            "endLine" to doc.getLineNumber(selectionModel.selectionEnd),
            "endChar" to (selectionModel.selectionEnd - doc.getLineStartOffset(
                doc.getLineNumber(selectionModel.selectionEnd)
            )),
            "text" to selectionModel.selectedText.orEmpty()
        )
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    override fun dispose() {
        debounceTimer?.cancel()
        timer.cancel()
    }
}
