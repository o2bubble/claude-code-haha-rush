package com.claude.code

import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Spawns `claude-ide.cmd` (Windows) or `claude-ide` (Unix) and connects via
 * WebSocket for messaging. The script is self-contained — it knows how to
 * launch Claude Code in IDE mode.
 *
 * This is a direct translation of VS Code processManager.ts (253 lines).
 * All logic is preserved 1:1 unless platform differences require adaptation.
 *
 * Key differences from VS Code:
 *   - WebSocket: java.net.http.WebSocket (JDK 11+) instead of browser WebSocket
 *   - Process:  ProcessBuilder instead of Node.js child_process.spawn
 *   - Events:   Kotlin lambdas instead of EventEmitter
 */
class ProcessManager(
    private val scriptPath: String,
    private val workspacePath: String?
) {
    // ── Callbacks (equivalent to EventEmitter events) ────────────────────

    var onStatus: ((String, Map<String, Any?>?) -> Unit)? = null
    var onLog: ((String) -> Unit)? = null
    var onMessage: ((String) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    // ── State ───────────────────────────────────────────────────────────

    private var process: Process? = null
    private var ws: WebSocket? = null
    private var wsUrl: String? = null

    private var started = false
    private var restartCount = 0
    private var restartDelay = INITIAL_RESTART_DELAY_MS

    /** Set to true by restart() to suppress auto-restart of old process */
    private var intentionalRestart = false

    /** Messages queued before WebSocket is open (max 50) */
    private val outgoingQueue = ConcurrentLinkedQueue<String>()

    companion object {
        private const val MAX_RESTARTS = 5
        private const val INITIAL_RESTART_DELAY_MS = 2000L
        private const val MAX_RESTART_DELAY_MS = 30000L
        private const val PORT_TIMEOUT_MS = 30_000L
    }

    // ── Public API ──────────────────────────────────────────────────────

    fun start() {
        if (started) return
        started = true
        spawnProcess()
    }

    fun stop() {
        started = false
        restartCount = 0
        restartDelay = INITIAL_RESTART_DELAY_MS
        killProcessAndWs(1000, "Extension deactivated")
    }

    fun send(message: String) {
        val socket = ws
        if (socket != null && !socket.isOutputClosed) {
            socket.sendText(message, true)
        } else {
            if (outgoingQueue.size < 50) {
                outgoingQueue.add(message)
            } else {
                onLog?.invoke("[ProcessManager] Outgoing queue full (50), dropping message")
            }
        }
    }

    fun isConnected(): Boolean = ws != null && !ws!!.isOutputClosed

    fun resetRestartCount() {
        restartCount = 0
        restartDelay = INITIAL_RESTART_DELAY_MS
    }

    /**
     * Kill current process and restart with fresh env (used for profile switching).
     * Mirrors VS Code processManager.ts:96-128.
     */
    fun restart() {
        resetRestartCount()
        intentionalRestart = true

        killProcessAndWs(1000, "Profile switch restart")

        onStatus?.invoke("restarting", null)

        // Spawn a new process after a short delay
        thread(name = "claude-code-restart") {
            Thread.sleep(500)
            intentionalRestart = false
            spawnProcess()
        }
    }

    // ── Process spawning ────────────────────────────────────────────────

    private fun spawnProcess() {
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        val isCmd = scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")
        val scriptFile = File(scriptPath)
        val repoRoot = File(scriptFile.parentFile?.parentFile, ".").absolutePath

        // Command construction:
        // - Windows .cmd/.bat:  claude-ide.cmd is just a trampoline that calls
        //   pwsh.exe -File claude.ps1 --ide-mode. Skip it and use pwsh directly
        //   to avoid cmd.exe quoting issues with space-containing paths.
        // - Windows .ps1:       run pwsh.exe directly
        // - Unix:               run bash directly
        val cmd: List<String> = when {
            isWindows && isCmd -> {
                // Replace .cmd/.bat with .ps1 — the .cmd is just a wrapper
                val ps1Path = scriptPath.replace(Regex("\\.(cmd|bat)$", RegexOption.IGNORE_CASE), ".ps1")
                val base = mutableListOf("pwsh.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path, "--ide-mode")
                if (workspacePath != null) base.addAll(listOf("--cwd", workspacePath))
                base
            }
            isWindows -> {
                val base = mutableListOf("pwsh.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
                if (workspacePath != null) base.addAll(listOf("--cwd", workspacePath))
                base
            }
            else -> {
                val base = mutableListOf("bash", scriptPath)
                if (workspacePath != null) base.addAll(listOf("--cwd", workspacePath))
                base
            }
        }

        onStatus?.invoke("starting", null)
        onLog?.invoke("Starting: ${cmd.joinToString(" ")} (cwd: $repoRoot)")

        val pb = ProcessBuilder(cmd)
            .directory(File(repoRoot))
            .redirectErrorStream(false) // keep stdout/stderr separate

        // Apply current env (may have been modified by profile switch)
        pb.environment().putAll(System.getenv())

        // Inject profile-managed system properties into process env
        for (key in ModelProfileManager.PROFILE_KEYS) {
            val value = System.getProperty(key)
            if (value != null) pb.environment()[key] = value
        }

        val proc = pb.start()
        process = proc

        // Discover WebSocket port from stdout (CLAUDE_CODE_IDE_PORT=<N>)
        val portTimeout = thread(name = "claude-code-port-timeout") {
            Thread.sleep(PORT_TIMEOUT_MS)
            if (wsUrl == null) {
                onError?.invoke("Claude Code did not start within ${PORT_TIMEOUT_MS / 1000}s. Check cliPath config.")
            }
        }

        thread(name = "claude-code-stdout") {
            proc.inputStream.bufferedReader().use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val text = line!!
                    val match = Regex("CLAUDE_CODE_IDE_PORT=(\\d+)").find(text)
                    if (match != null) {
                        portTimeout.interrupt()
                        val port = match.groupValues[1].toInt()
                        wsUrl = "ws://127.0.0.1:$port"
                        connectWebSocket()
                    }
                }
            }
        }

        thread(name = "claude-code-stderr") {
            proc.errorStream.bufferedReader().use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    onLog?.invoke(line!!.trim())
                }
            }
        }

        thread(name = "claude-code-exit-watcher") {
            val code = proc.waitFor()
            // Ignore stale exit from old process (mirrors TS:194)
            if (process !== proc) return@thread

            onStatus?.invoke("exited", mapOf("code" to code))
            process = null

            // Ensure no grandchildren survived. On Windows, taskkill /T is a
            // belt-and-suspenders safety net — cmd.exe /c should have waited
            // for the full chain, but rare edge cases (external kill signals,
            // detached child processes) can leave orphans.
            killProcessTree(proc)

            if (intentionalRestart) return@thread

            if (started && code != 0 && restartCount < MAX_RESTARTS) {
                restartCount++
                onLog?.invoke("Exited (code=$code), restarting in ${restartDelay}ms ($restartCount/$MAX_RESTARTS)")
                Thread.sleep(restartDelay)
                restartDelay = minOf(restartDelay * 2, MAX_RESTART_DELAY_MS)
                spawnProcess()
            }
        }
    }

    // ── WebSocket ───────────────────────────────────────────────────────

    private fun connectWebSocket() {
        val url = wsUrl ?: return
        val wsUri = "$url/ws"
        onLog?.invoke("Connecting to $wsUri")

        val client = HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofMillis(PORT_TIMEOUT_MS))
            .build()

        // Fragment buffer — large messages are delivered in multiple onText calls
        var fragBuf = StringBuilder()

        client.newWebSocketBuilder()
            .buildAsync(URI(wsUri), object : WebSocket.Listener {
                override fun onOpen(webSocket: WebSocket) {
                    ws = webSocket
                    onStatus?.invoke("connected", null)
                    onLog?.invoke("WebSocket connected")
                    restartCount = 0
                    restartDelay = INITIAL_RESTART_DELAY_MS

                    // Flush outgoing queue
                    while (true) {
                        val msg = outgoingQueue.poll() ?: break
                        if (!webSocket.isOutputClosed) {
                            webSocket.sendText(msg, true)
                        }
                    }

                    // Request the first message from the backend
                    webSocket.request(1)
                }

                override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                    fragBuf.append(data)
                    if (!last) {
                        webSocket.request(1)
                        return null
                    }
                    // Last fragment — accumulate complete message and process
                    val text = fragBuf.toString()
                    fragBuf = StringBuilder()
                    try {
                        if (text.startsWith("{") && text.contains("\"type\"")) {
                            onMessage?.invoke(text)
                        }
                    } catch (_: Exception) { }
                    webSocket.request(1)
                    return null
                }

                override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
                    onStatus?.invoke("disconnected", mapOf("code" to statusCode, "reason" to reason))

                    // Reconnect WebSocket if process is still alive
                    if (started && process != null && statusCode != 1000) {
                        onLog?.invoke("WebSocket closed ($statusCode), reconnecting...")
                        Thread.sleep(1000)
                        connectWebSocket()
                    }
                    return null
                }

                override fun onError(webSocket: WebSocket, error: Throwable?) {
                    onLog?.invoke("WebSocket error: ${error?.message}")
                }
            })
            .thenAccept { /* ws is set in onOpen */ }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private fun killProcessAndWs(closeCode: Int, reason: String) {
        // Close WebSocket
        ws?.sendClose(closeCode, reason)
        ws = null
        wsUrl = null

        val p = process ?: return
        process = null
        killProcessTree(p)
    }

    /**
     * Kill a process and all its descendants, waiting for completion.
     * On Windows, uses taskkill /F /T to recursively terminate the entire
     * process tree (cmd.exe → powershell.exe → bun.exe → ...).
     * On Unix, uses destroy() / destroyForcibly() with fallback.
     */
    private fun killProcessTree(proc: Process) {
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        if (isWindows) {
            try {
                val killer = ProcessBuilder("taskkill", "/F", "/T", "/PID", proc.pid().toString())
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start()
                killer.waitFor(10, TimeUnit.SECONDS)
            } catch (_: Exception) {
                // taskkill may fail if the process already exited — that's fine
            }
        } else if (proc.isAlive) {
            proc.destroy()
            if (!proc.waitFor(5, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                proc.waitFor(5, TimeUnit.SECONDS)
            }
        }
    }
}
