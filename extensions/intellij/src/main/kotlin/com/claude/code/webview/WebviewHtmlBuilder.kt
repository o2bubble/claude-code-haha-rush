package com.claude.code.webview

/**
 * Builds the complete HTML document for the JCEF webview by reading the
 * template and inlining all CSS/JS/assets from the classpath.
 *
 * Uses ClassLoader.getResourceAsStream() so it works both in dev mode
 * (filesystem build/resources/main/) and production (inside JAR).
 *
 * Mirrors VS Code provider.ts:getHtmlContent() (lines 595-623).
 */
object WebviewHtmlBuilder {

    private var cachedHtml: String? = null
    private var cachedLocaleLang: String? = null
    private var cachedBridgeJs: String? = null

    /**
     * Pre-compute the bridge JS snippet. Called once by WebviewBridge.init()
     * before build(). The snippet is embedded in the HTML so that
     * window.sendToJava is available before any page script runs.
     */
    fun setBridgeJs(js: String) {
        cachedBridgeJs = js
        cachedHtml = null // invalidate: HTML must be rebuilt with bridge JS
        cachedLocaleLang = null
    }

    /**
     * Build the full HTML string.
     *
     * @param language  UI language: "auto", "en", "zh-cn"
     */
    fun build(language: String): String {
        if (cachedHtml != null && cachedLocaleLang == language) {
            return cachedHtml!!
        }

        val cl = javaClass.classLoader

        val template = cl.readResource("webview/template.html")
        val tokensCss = cl.readResource("webview/tokens.css")
        val stylesNewCss = cl.readResource("webview/styles-new.css")
        val hljsCss = cl.readResource("webview-assets/github-dark-dimmed.min.css")
            .replace("</style>", "<\\/style>")
        val hljsJs = cl.readResource("webview-assets/highlight.bundle.js")
        val markedJs = cl.readResource("webview-assets/marked.umd.js")
            .replace(Regex("//# sourceMappingURL=.*"), "")
        val markedHighlightJs = cl.readResource("webview-assets/marked-highlight.umd.js")
            .replace(Regex("//# sourceMappingURL=.*"), "")

        // Font Awesome — may not be bundled, skip if missing
        val faCss = cl.readResourceOrNull("media/fontawesome/css/all.min.css")

        // Locale data
        val localeData = loadLocale(language, cl)

        // Utility scripts (order matters)
        val localeJs = cl.readResource("webview/utils/locale.js")
        val stateJs = cl.readResource("webview/utils/state.js")
        val domJs = cl.readResource("webview/utils/dom.js")
        val apiJs = cl.readResource("webview/utils/api.js")

        // Component scripts
        val sessionPanelJs = cl.readResource("webview/components/session-panel.js")
        val messageStreamJs = cl.readResource("webview/components/message-stream.js")
        val inputAreaJs = cl.readResource("webview/components/input-area.js")
        val contextBarJs = cl.readResource("webview/components/context-bar.js")
        val selectionPreviewJs = cl.readResource("webview/components/selection-preview.js")
        val statusBarJs = cl.readResource("webview/components/status-bar.js")
        val tasksPanelJs = cl.readResource("webview/components/tasks-panel.js")
        val planPanelJs = cl.readResource("webview/components/plan-panel.js")
        val queuePanelJs = cl.readResource("webview/components/queue-panel.js")

        // Overlay scripts
        val permPromptJs = cl.readResource("webview/overlays/permission-prompt.js")
        val rewindPointsJs = cl.readResource("webview/overlays/rewind-points.js")
        val toastJs = cl.readResource("webview/overlays/toast.js")
        val filePickerJs = cl.readResource("webview/overlays/file-picker.js")
        val emojiPickerJs = cl.readResource("webview/overlays/emoji-picker.js")
        val slashAutocompleteJs = cl.readResource("webview/overlays/slash-autocomplete.js")
        val markdownEditorJs = cl.readResource("webview/overlays/markdown-editor.js")
        val quickCmdManagerJs = cl.readResource("webview/overlays/quick-command-manager.js")
        val sideQuestionJs = cl.readResource("webview/overlays/side-question.js")
        val contextDetailJs = cl.readResource("webview/overlays/context-detail.js")
        val historyBrowserJs = cl.readResource("webview/overlays/history-browser.js")

        // Main app script (loaded last)
        val appNewJs = cl.readResource("webview/app-new.js")

        // Shim: replace acquireVsCodeApi with a stub that routes through
        // window.sendToJava (which is already defined by bridgeJs above).
        val vscodeShim = """
window.acquireVsCodeApi = function() {
  console.log('[intellij-shim] acquireVsCodeApi called');
  return {
    postMessage: function(msg) {
      console.log('[intellij-shim] postMessage', msg.type || 'unknown');
      if (window.sendToJava) {
        window.sendToJava(JSON.stringify(msg));
      } else {
        console.error('[intellij-shim] sendToJava not available!');
      }
    },
    getState: function() { return {}; },
    setState: function() {}
  };
};
""".trimIndent()

        // Bridge JS (window.sendToJava) — inserted BEFORE all page scripts so
        // that API.send() works immediately (the vscodeShim below overrides
        // acquireVsCodeApi to use window.sendToJava).
        val bridgeJs = cachedBridgeJs ?: ""

        // Concatenate all JS in the same order as VS Code provider.ts:614-622
        val appJsBundle = listOf(
            bridgeJs,
            vscodeShim,
            localeJs, stateJs, domJs, apiJs,
            sessionPanelJs, messageStreamJs,
            inputAreaJs, contextBarJs, selectionPreviewJs,
            statusBarJs, tasksPanelJs, planPanelJs, queuePanelJs,
            permPromptJs, rewindPointsJs, toastJs,
            filePickerJs, emojiPickerJs, slashAutocompleteJs,
            markdownEditorJs, quickCmdManagerJs, sideQuestionJs, contextDetailJs, historyBrowserJs,
            appNewJs
        ).joinToString("\n")

        // JCEF-friendly CSP (loadHTML has no cross-origin risk)
        val cspMeta = "<meta http-equiv=\"Content-Security-Policy\" " +
            "content=\"default-src 'unsafe-inline' 'unsafe-eval'; " +
            "img-src data: https:; font-src 'self' data: 'unsafe-inline'\">"
        val faCssTag = if (faCss != null) "<style>$faCss</style>" else ""

        val html = template
            .replace(
                Regex(
                    """<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*/?>""",
                    RegexOption.IGNORE_CASE
                ),
                cspMeta
            )
            .replace("{{NONCE}}", "")
            .replace("{{FA_CSS_URI}}", "")
            .replace("{{LOCALE_DATA}}", localeData)
            .replace("{{TOKENS_CSS}}", tokensCss)
            .replace("{{STYLES_NEW_CSS}}", stylesNewCss)
            .replace("{{HLJS_CSS}}", hljsCss)
            .replace("{{HLJS_JS}}", hljsJs)
            .replace("{{MARKED_JS}}", markedJs)
            .replace("{{MARKED_HIGHLIGHT_JS}}", markedHighlightJs)
            .replace("{{APP_NEW_JS}}", appJsBundle)
            .replace("</title>", "</title>\n  $faCssTag")

        cachedHtml = html
        cachedLocaleLang = language
        return html
    }

    fun clearCache() {
        cachedHtml = null
        cachedLocaleLang = null
    }

    // ── helpers ──────────────────────────────────────────────────────

    private fun ClassLoader.readResource(name: String): String {
        return getResourceAsStream(name)?.bufferedReader(Charsets.UTF_8)?.readText()
            ?: throw RuntimeException("Missing required resource: $name")
    }

    private fun ClassLoader.readResourceOrNull(name: String): String? {
        return try {
            getResourceAsStream(name)?.bufferedReader(Charsets.UTF_8)?.readText()
        } catch (_: Exception) {
            null
        }
    }

    private fun loadLocale(language: String, cl: ClassLoader): String {
        val localesDir = "webview/locales"

        fun tryLoad(locale: String): String? {
            return cl.readResourceOrNull("$localesDir/$locale.json")
        }

        var data = tryLoad(language)
        if (data == null && language.contains('-')) {
            data = tryLoad(language.substringBefore('-'))
        }
        if (data == null) {
            data = tryLoad("en")
        }
        return data ?: "{}"
    }
}
