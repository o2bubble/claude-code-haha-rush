package com.claude.code.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Persistent plugin settings stored in IDE config directory.
 *
 * Mirrors VS Code package.json contributes.configuration (lines 115-144).
 * These settings survive IDE restarts and are synchronized across IDE instances.
 */
@State(
    name = "ClaudeCodeSettings",
    storages = [Storage("claude-code.xml")]
)
class ClaudeCodeSettings : PersistentStateComponent<ClaudeCodeSettings> {

    /**
     * Path to claude-code-haha-dev repository root.
     * Contains bin/claude-ide.cmd and bunfig.toml.
     */
    var cliPath: String = ""

    /** Automatically send active file, selection, and diagnostics context */
    var autoSendContext: Boolean = true

    /** Maximum number of open files to include in context */
    var maxFilesInContext: Int = 5

    /**
     * UI language: "auto" (follow IDE), "en", or "zh-cn".
     * Default "auto" follows IntelliJ's locale.
     */
    var language: String = "auto"

    override fun getState(): ClaudeCodeSettings = this

    override fun loadState(state: ClaudeCodeSettings) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun getInstance(): ClaudeCodeSettings {
            return ApplicationManager.getApplication()
                .getService(ClaudeCodeSettings::class.java)
        }
    }
}
