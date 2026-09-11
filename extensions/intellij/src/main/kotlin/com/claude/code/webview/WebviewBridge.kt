package com.claude.code.webview

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import java.util.concurrent.ConcurrentLinkedQueue

class WebviewBridge(
    private val browser: JBCefBrowser,
    private val onMessageFromJs: (String) -> Unit
) {
    private val gson = Gson()
    private var jsQuery: JBCefJSQuery? = null
    private var isWebviewReady = false
    private val messageQueue = mutableListOf<String>()
    private val outgoingQueue = ConcurrentLinkedQueue<String>()
    private val logBuffer = mutableListOf<String>()
    private val maxLogBuffer = 100
    private var chunkId = 0
    private val maxChunk = 2000

    fun init() {
        jsQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
        jsQuery!!.addHandler { json ->
            ApplicationManager.getApplication().invokeLater { handleJsMessage(json) }
            val msg = outgoingQueue.poll()
            if (msg != null) JBCefJSQuery.Response(msg) else JBCefJSQuery.Response("")
        }

        val rawCode = jsQuery!!.inject("data")
        val fixedCode = rawCode.replace(
            "onSuccess: function(response) {}",
            "onSuccess: function(r) { window._jcefRecv(r) }"
        )
        val bridgeJs = """
window._jcefBuf={};
window._jcefRecv=function(r){if(!r)return;
var m=r.match(/^C([0-9]+):([0-9]+)!(.*)/);
if(m){var id=m[1],idx=parseInt(m[2]);if(!window._jcefBuf[id])window._jcefBuf[id]=[];window._jcefBuf[id][idx]=m[3];return}
m=r.match(/^E([0-9]+):([0-9]+)/);
if(m){var id=m[1],cnt=parseInt(m[2]),buf='';for(var i=0;i<cnt;i++)buf+=(window._jcefBuf[id][i]||'');delete window._jcefBuf[id];r=buf}
try{var p=JSON.parse(r);if(p&&p.type)window.postMessage(p,'*')}catch(e){console.error('[bridge] parse fail, len='+r.length+' pre='+r.substring(0,80)+' suf='+r.substring(r.length-20))}
};
window.sendToJava=function(data){$fixedCode};
setInterval(function(){window.sendToJava('{"type":"__poll"}')},20);
""".trimIndent()
        WebviewHtmlBuilder.setBridgeJs(bridgeJs)
    }

    @Synchronized
    fun sendToWebview(json: String) {
        if (!isWebviewReady) { messageQueue.add(json); return }
        if (json.length > maxChunk) {
            val id = (++chunkId).toString()
            var offset = 0; var idx = 0
            while (offset < json.length) {
                val end = minOf(offset + maxChunk, json.length)
                outgoingQueue.add("C$id:$idx!${json.substring(offset, end)}")
                offset = end; idx++
            }
            outgoingQueue.add("E$id:$idx")
        } else {
            outgoingQueue.add(json)
        }
    }

    fun appendLog(line: String) {
        logBuffer.add(line.trim())
        if (logBuffer.size > maxLogBuffer) logBuffer.removeAt(0)
        if (isWebviewReady)
            outgoingQueue.add(gson.toJson(mapOf("type" to "log", "message" to line.trim())))
    }

    fun isReady(): Boolean = isWebviewReady

    private fun handleJsMessage(json: String) {
        val root = try { JsonParser.parseString(json) } catch (_: Exception) { return }
        if (!root.isJsonObject) return
        val type = root.asJsonObject.get("type")?.asString ?: return
        if (type == "__poll") return
        println("[bridge] JS→Java: $type")
        if (type == "ready") {
            isWebviewReady = true
            for (msg in messageQueue) sendToWebview(msg)
            messageQueue.clear()
            for (log in logBuffer) sendToWebview(gson.toJson(mapOf("type" to "log", "message" to log)))
            logBuffer.clear()
        }
        onMessageFromJs(json)
    }

    fun dispose() {
        isWebviewReady = false
        messageQueue.clear()
        outgoingQueue.clear()
        logBuffer.clear()
        jsQuery = null
    }
}
