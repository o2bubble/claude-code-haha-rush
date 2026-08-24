package com.claude.code.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.panel
import javax.swing.JComponent

/**
 * Settings page under Settings → Tools → Claude Code.
 *
 * Mirrors VS Code package.json contributes.configuration (lines 115-144).
 * Values are persisted via ClaudeCodeSettings PersistentStateComponent.
 */
class ClaudeCodeConfigurable : Configurable {

    private val settings = ClaudeCodeSettings.getInstance()

    // Form fields (created in createComponent, read in apply/isModified/reset)
    private var cliPathField: JBTextField? = null
    private var autoSendContextCheck: JBCheckBox? = null
    private var languageCombo: javax.swing.JComboBox<String>? = null

    // Snapshot of current values for isModified()
    private var savedCliPath: String = ""
    private var savedAutoSend: Boolean = true
    private var savedLanguage: String = "auto"

    override fun getDisplayName(): String = "Claude Code"

    override fun createComponent(): JComponent {
        val cliField = JBTextField().also { cliPathField = it }
        val autoCheck = JBCheckBox("Auto-send active file & selection context").also { autoSendContextCheck = it }
        val langCombo = javax.swing.JComboBox(arrayOf("auto", "en", "zh-cn")).also { languageCombo = it }

        return panel {
            group("Backend") {
                row("Repository path:") {
                    cell(cliField)
                        .comment("Path to claude-code-haha-dev root (contains bin/claude-ide.cmd and bunfig.toml)")
                }
            }
            group("Editor Context") {
                row {
                    cell(autoCheck)
                        .comment("When enabled, the active editor content and selection are sent to Claude automatically")
                }
            }
            group("Display") {
                row("Language:") {
                    cell(langCombo)
                        .comment("UI language for the Claude Code chat panel")
                }
            }
        }
    }

    override fun isModified(): Boolean {
        return cliPathField?.text != savedCliPath
            || autoSendContextCheck?.isSelected != savedAutoSend
            || languageCombo?.selectedItem?.toString() != savedLanguage
    }

    override fun apply() {
        settings.cliPath = cliPathField?.text?.trim() ?: ""
        settings.autoSendContext = autoSendContextCheck?.isSelected ?: true
        settings.language = languageCombo?.selectedItem?.toString() ?: "auto"

        // Update saved snapshot
        savedCliPath = settings.cliPath
        savedAutoSend = settings.autoSendContext
        savedLanguage = settings.language
    }

    override fun reset() {
        savedCliPath = settings.cliPath
        savedAutoSend = settings.autoSendContext
        savedLanguage = settings.language

        cliPathField?.text = settings.cliPath
        autoSendContextCheck?.isSelected = settings.autoSendContext
        languageCombo?.selectedItem = settings.language
    }
}
