using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Microsoft.VisualStudio.Shell;

namespace ClaudeCodeVS.ToolWindows
{
    /// <summary>
    /// COM-visible bridge object exposed to JS via AddHostObjectToScript.
    /// Provides a direct JS→C# call channel, bypassing chrome.webview.postMessage
    /// which does not work in VS2026 WebView2 SDK.
    /// </summary>
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class NativeBridge
    {
        private readonly ConcurrentQueue<string> _incoming = new ConcurrentQueue<string>();

        /// <summary>
        /// Called from JS to post a JSON message to C#.
        /// Returns "ok" so the caller knows it was received.
        /// </summary>
        public string PostMessage(string json)
        {
            _incoming.Enqueue(json);
            return "ok";
        }

        /// <summary>
        /// Drains all queued messages. Called from C# UI thread on a timer or when polled.
        /// </summary>
        public bool TryDequeue(out string json)
        {
            return _incoming.TryDequeue(out json);
        }

        /// <summary>
        /// Returns the number of pending messages.
        /// </summary>
        public int PendingCount => _incoming.Count;
    }

    /// <summary>
    /// WPF UserControl hosting the WebView2 chat UI.
    /// Wires ProcessManager → WebSocketClient → WebView2 message routing.
    /// Replaces extensions/vscode/src/webview/provider.ts.
    /// </summary>
    public partial class ClaudeChatWindowControl : UserControl
    {
        private Services.ProcessManager _processManager;
        private Services.WebSocketClient _wsClient;
        private NativeBridge _nativeBridge;
        private System.Windows.Threading.DispatcherTimer _bridgePollTimer;
        private bool _isReady;
        private bool _backendStarting; // guard against duplicate StartBackendAsync
        private string _repoRoot; // derived from script path

        // Queue messages until backend WebSocket is connected, then re-send
        private readonly System.Collections.Concurrent.ConcurrentQueue<string> _outgoingQueue =
            new System.Collections.Concurrent.ConcurrentQueue<string>();

        public ClaudeChatWindowControl()
        {
            InitializeComponent();
            InitializeWebViewAsync();
            // Note: do NOT hook Unloaded — in VS tabbed tool windows,
            // Unloaded fires when switching between tabs, which would
            // kill the backend process and block the UI thread.
        }

        // ── WebView2 Initialization ───────────────────────────────────────

        private async void InitializeWebViewAsync()
        {
            Services.Logger.Info("WebView2 initializing...");
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ClaudeCodeVS", "WebView2Data");

            var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
            await webView.EnsureCoreWebView2Async(env);

            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
            webView.DefaultBackgroundColor = System.Drawing.Color.Transparent;

            // Inject locale data before any page loads
            var localeJson = LoadLocaleData();
            webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                $"window.__localeData = {localeJson};" +
                "function __t(key, params) {" +
                "  var val = (window.__localeData || {})[key];" +
                "  if (!val) return key;" +
                "  if (params) {" +
                "    for (var k in params) {" +
                "      if (params.hasOwnProperty(k)) {" +
                "        val = val.replace(new RegExp('{' + k + '}', 'g'), String(params[k]));" +
                "      }" +
                "    }" +
                "  }" +
                "  return val;" +
                "}"
            );

            // Build complete HTML by inlining all JS/CSS (same as VS Code extension).
            // Use virtual host mapping so the page has an https:// origin —
            // VS2026 WebView2 requires a proper origin for chrome.webview.postMessage.
            var html = BuildInlinedHtml();
            Services.Logger.Info($"WebView2 HTML built: {html.Length} chars");

            var tempDir = Path.Combine(Path.GetTempPath(), "ClaudeCodeVS");
            Directory.CreateDirectory(tempDir);
            var tempPath = Path.Combine(tempDir, "chat.html");
            File.WriteAllText(tempPath, html, Encoding.UTF8);
            Services.Logger.Info($"WebView2 HTML written to: {tempPath}");

            webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "claude-code.app", tempDir, CoreWebView2HostResourceAccessKind.Allow);
            Services.Logger.Info("WebView2 virtual host mapping set: claude-code.app");

            // Register native bridge — JS calls hostObjects.sync.hostBridge.PostMessage(json)
            // directly instead of chrome.webview.postMessage, because WebMessageReceived
            // does not fire in VS2026 WebView2 SDK (regardless of origin).
            _nativeBridge = new NativeBridge();
            webView.CoreWebView2.AddHostObjectToScript("hostBridge", _nativeBridge);
            Services.Logger.Info("WebView2 AddHostObjectToScript registered");

            // Poll the native bridge for incoming messages (every 200ms)
            _bridgePollTimer = new System.Windows.Threading.DispatcherTimer(
                TimeSpan.FromMilliseconds(200),
                System.Windows.Threading.DispatcherPriority.Normal,
                OnBridgePoll,
                this.Dispatcher);
            _bridgePollTimer.Start();
            Services.Logger.Info("WebView2 bridge poll timer started");

            webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            Services.Logger.Info("WebView2 WebMessageReceived handler registered");
            webView.CoreWebView2.NavigationCompleted += (s, ev) =>
            {
                Services.Logger.Info($"WebView2 NavigationCompleted: IsSuccess={ev.IsSuccess}");
                // Diagnostic: test C# → JS bridge direction
                try
                {
                    webView.CoreWebView2.PostWebMessageAsJson("{\"type\":\"diag_csharp_bridge\"}");
                    Services.Logger.Info("PostWebMessageAsJson diagnostic sent");
                }
                catch (Exception ex)
                {
                    Services.Logger.Error($"PostWebMessageAsJson failed: {ex.Message}");
                }
            };

            webView.CoreWebView2.Navigate("https://claude-code.app/chat.html");
            Services.Logger.Info("WebView2 Navigate called: https://claude-code.app/chat.html");
        }

        // ── Message Routing: WebView2 ↔ WebSocket ────────────────────────

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Services.Logger.Info("OnWebMessageReceived FIRED");
            try
            {
                string json = null;

                // Fallback chain: try multiple WebView2 SDK APIs for receiving
                // Method 1: WebMessageAsJson (VS2022 SDK — postMessage(object) arrives as JSON)
                try { json = e.WebMessageAsJson; } catch { }

                // Method 2: TryGetWebMessageAsString (VS2026 SDK — postMessage(string) arrives as raw string)
                if (string.IsNullOrEmpty(json))
                {
                    try { json = e.TryGetWebMessageAsString(); } catch { }
                }

                // Method 3: If the raw string is not JSON, try to extract from "{type}:{payload}" format
                if (!string.IsNullOrEmpty(json) && !json.TrimStart().StartsWith("{"))
                {
                    var colonIdx = json.IndexOf(':');
                    if (colonIdx > 1)
                    {
                        var rawType = json.Substring(0, colonIdx);
                        var rawPayload = json.Substring(colonIdx + 1);
                        try
                        {
                            var payloadObj = JToken.Parse(rawPayload);
                            json = JsonConvert.SerializeObject(new { type = rawType, payload = payloadObj });
                        }
                        catch { /* ignore — not valid JSON payload */ }
                    }
                }

                // Log raw message for debugging (trimmed)
                var logPreview = json ?? "(null)";
                if (logPreview.Length > 200) logPreview = logPreview.Substring(0, 200) + "...";
                Services.Logger.Info($"WebMessage: {logPreview}");

                if (string.IsNullOrEmpty(json))
                {
                    Services.Logger.Warn("WebMessage: all fallback methods failed, message dropped");
                    return;
                }

                var root = JObject.Parse(json);

                // Non-object messages have no type — skip
                if (root.Type != JTokenType.Object) return;

                var type = root["type"]?.Value<string>();
                if (type == null) return;

                // ── Diagnostic: bridge test ──────────────────────────────
                if (type == "diag_bridge_ok")
                {
                    Services.Logger.Info("WebView bridge verified OK");
                    return;
                }

                // ── ready: backend lifecycle ─────────────────────────────
                if (type == "ready")
                {
                    Services.Logger.Info("WebView READY — starting backend...");
                    _isReady = true;
                    StartBackendAsync();
                    return;
                }

                // ── Locally handled messages ────────────────────────────
                if (type == "open_file")
                {
                    var rawPath = root["path"]?.Value<string>();
                    if (!string.IsNullOrEmpty(rawPath))
                    {
                        var path = rawPath;
                        if (!System.IO.Path.IsPathRooted(path))
                        {
                            try
                            {
                                var dte2 = (EnvDTE80.DTE2)Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE));
                                var solDir = System.IO.Path.GetDirectoryName(dte2?.Solution?.FullName);
                                if (!string.IsNullOrEmpty(solDir))
                                    path = System.IO.Path.Combine(solDir, rawPath);
                            }
                            catch { }
                        }
                        if (File.Exists(path))
                        {
                            System.Threading.Tasks.Task.Run(() =>
                            {
                                try
                                {
                                    var dte = (EnvDTE80.DTE2)Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE));
                                    dte?.ItemOperations.OpenFile(path, EnvDTE.Constants.vsViewKindTextView);
                                }
                                catch { /* fallback to external open */ }
                            });
                        }
                    }
                    return;
                }

                if (type == "request_model_profiles")
                {
                    SendModelProfiles();
                    return;
                }

                if (type == "set_model_profile")
                {
                    var profileId = root["profileId"]?.Value<string>()
                                 ?? root["profile"]?.Value<string>();
                    if (!string.IsNullOrEmpty(profileId))
                        ApplyModelProfile(profileId);
                    return;
                }

                if (type == "get_quick_cmds")
                {
                    SendQuickCommands();
                    return;
                }

                if (type == "save_quick_cmds")
                {
                    SaveQuickCommands(root);
                    return;
                }

                if (type == "request_file_content")
                {
                    var filePath = root["path"]?.Value<string>();
                    var isDir = root["isDir"]?.Value<bool>() ?? false;
                    SendFileContent(filePath, isDir);
                    return;
                }

                if (type == "request_file_pick")
                {
                    SendWorkspaceFiles();
                    return;
                }

                // ── Transformations before forwarding ────────────────────
                if (type == "user_message")
                {
                    ForwardUserMessage(root);
                    return;
                }

                if (type == "control_response")
                {
                    ForwardControlResponse(root);
                    return;
                }

                // ── Pass-through to Bun backend (background to avoid blocking UI) ──
                if (_wsClient?.IsConnected == true)
                {
                    var msg = json;
                    System.Threading.Tasks.Task.Run(() => _wsClient.Send(msg));
                }
                else
                {
                    // Queue up to 50 messages while backend is starting
                    if (_outgoingQueue.Count < 50)
                    {
                        _outgoingQueue.Enqueue(json);
                        Services.Logger.Info($"Queued message (backend not ready): type={type}, queueSize={_outgoingQueue.Count}");
                    }
                    else
                    {
                        Services.Logger.Warn($"Queue full, message dropped: type={type}");
                    }
                }
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"OnWebMessageReceived: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // ── Message Transform Helpers ────────────────────────────────────

        private void ForwardUserMessage(JToken root)
        {
            if (_wsClient?.IsConnected != true)
            {
                Services.Logger.Warn("user_message dropped: not connected");
                return;
            }
            var content = root["content"]?.Value<string>() ?? "";
            var msg = new System.Collections.Generic.Dictionary<string, object>
            {
                { "type", "user" },
                { "message", new System.Collections.Generic.Dictionary<string, object>
                    { { "role", "user" }, { "content", content } } },
                { "parent_tool_use_id", null! },
            };
            var atts = root["attachments"];
            if (atts != null && atts.Type == JTokenType.Array)
            {
                msg["attachments"] = JsonConvert.DeserializeObject(atts.ToString());
            }
            var json = JsonConvert.SerializeObject(msg);
            System.Threading.Tasks.Task.Run(() => _wsClient.Send(json));
        }

        private void ForwardControlResponse(JToken root)
        {
            if (_wsClient?.IsConnected != true) return;

            var requestId = root["request_id"]?.Value<string>();
            var allowed = root["allowed"]?.Value<bool>() ?? false;
            var always = root["always"]?.Value<bool>() ?? false;
            var se = root["session"];
            var session = se != null && se.Type != JTokenType.Null ? se.Value<bool>() : (bool?)null;
            var re = root["reason"];
            var reason = re != null && re.Type == JTokenType.String ? re.Value<string>() : null;
            var updatedInput = root["updatedInput"];

            var responseObj = new System.Collections.Generic.Dictionary<string, object>
            {
                { "allowed", allowed },
                { "always", always },
            };
            if (session.HasValue) responseObj["session"] = session.Value;
            if (reason != null) responseObj["reason"] = reason;
            if (updatedInput != null) responseObj["updatedInput"] = updatedInput;

            var msg = new System.Collections.Generic.Dictionary<string, object>
            {
                { "type", "control_response" },
                { "request_id", requestId ?? "" },
                { "response", responseObj },
            };
            var json = JsonConvert.SerializeObject(msg);

            // Fire-and-forget on thread pool to avoid any potential UI blocking
            System.Threading.Tasks.Task.Run(() => _wsClient.Send(json));
        }

        public void SendToWebView(string json) => PostMessageToWebview(json);

        private void PostMessageToWebview(string json)
        {
            if (webView == null) return;
            // If already on UI thread, post directly (avoids unnecessary Dispatcher.Invoke)
            if (webView.Dispatcher.CheckAccess())
            {
                try
                {
                    webView.CoreWebView2?.PostWebMessageAsJson(json);
                }
                catch { }
            }
            else
            {
                webView.Dispatcher.Invoke(() =>
                {
                    try { webView.CoreWebView2?.PostWebMessageAsJson(json); } catch { }
                });
            }
        }

        // ── Backend Lifecycle ─────────────────────────────────────────────

        private async void StartBackendAsync()
        {
            // Guard: prevent duplicate starts
            if (_backendStarting || _processManager?.IsRunning == true) return;
            _backendStarting = true;

            try
            {
                var scriptPath = FindIdeScript();
                Services.Logger.Info($"StartBackend: FindIdeScript returned: {scriptPath ?? "(null)"}");
                // Derive repo root from script: <repo>/bin/claude-ide.cmd
                _repoRoot = !string.IsNullOrEmpty(scriptPath)
                    ? Path.GetDirectoryName(Path.GetDirectoryName(scriptPath))
                    : null;
                if (string.IsNullOrEmpty(scriptPath))
                {
                    Services.Logger.Error("StartBackend: script not found, aborting");
                    PostMessageToWebview("{\"type\":\"error\",\"message\":\"Claude IDE script not found. Check %TEMP%\\\\ClaudeCodeVS.log\"}");
                    return;
                }

                // Get solution path — called from bridge poll (UI thread), no JoinableTaskFactory needed
                string workspacePath = null;
                try
                {
                    // We're on the UI thread (called from DispatcherTimer callback)
                    var dte = (EnvDTE80.DTE2)Package.GetGlobalService(typeof(EnvDTE.DTE));
                    if (dte?.Solution != null && !string.IsNullOrEmpty(dte.Solution.FullName))
                        workspacePath = Path.GetDirectoryName(dte.Solution.FullName);

                    if (string.IsNullOrEmpty(workspacePath) && dte?.Solution != null)
                        try { workspacePath = Path.GetDirectoryName(dte.Solution.FileName); } catch { }

                    if (string.IsNullOrEmpty(workspacePath))
                    {
                        var solService = Package.GetGlobalService(typeof(Microsoft.VisualStudio.Shell.Interop.IVsSolution))
                            as Microsoft.VisualStudio.Shell.Interop.IVsSolution;
                        if (solService != null)
                        {
                            string solDir, solFile, solUserOpts;
                            solService.GetSolutionInfo(out solDir, out solFile, out solUserOpts);
                            if (!string.IsNullOrEmpty(solDir)) workspacePath = solDir;
                        }
                    }

                    Services.Logger.Info(!string.IsNullOrEmpty(workspacePath)
                        ? "StartBackend: workspacePath=" + workspacePath
                        : "StartBackend: no workspace path available");
                }
                catch (Exception ex)
                {
                    Services.Logger.Error("StartBackend: DTE access failed: " + ex.Message);
                }

                Services.Logger.Info($"StartBackend: launching script: {scriptPath}, workspacePath: {workspacePath ?? "(null)"}");

                _processManager = new Services.ProcessManager(scriptPath)
                {
                    WorkspacePath = workspacePath,
                };
                _processManager.LogReceived += (s, log) =>
                {
                    PostMessageToWebview($"{{\"type\":\"log\",\"message\":\"{EscapeJson(log)}\"}}");
                };
                _processManager.StatusChanged += (s, status) =>
                {
                    PostMessageToWebview($"{{\"type\":\"status\",\"status\":\"{EscapeJson(status)}\"}}");
                };

                await _processManager.StartAsync();

                if (_processManager.WebSocketPort.HasValue)
                {
                    _wsClient = new Services.WebSocketClient(_processManager.WebSocketUrl);
                    _wsClient.MessageReceived += (s, json) => PostMessageToWebview(json);
                    _wsClient.StatusChanged += (s, status) =>
                    {
                        PostMessageToWebview($"{{\"type\":\"status\",\"status\":\"{EscapeJson(status)}\"}}");
                    };

                    await _wsClient.ConnectAsync();

                // Flush queued messages after WebSocket is connected
                FlushOutgoingQueue();
                }
            }
            catch (Exception ex)
            {
                PostMessageToWebview($"{{\"type\":\"error\",\"message\":\"Failed to start backend: {EscapeJson(ex.Message)}\"}}");
            }
            finally
            {
                _backendStarting = false;
            }
        }

        // ── Model Profile Management ─────────────────────────────────────

        private void SendModelProfiles()
        {
            // Offload filesystem reads to background thread
            System.Threading.Tasks.Task.Run(() =>
            {
                try
                {
                    var profilesDir = FindProfilesDir();
                    var profiles = new System.Collections.Generic.List<object>();
                    string activeProfile = null;

                    if (Directory.Exists(profilesDir))
                    {
                        foreach (var f in Directory.GetFiles(profilesDir, "*.env"))
                        {
                            var name = Path.GetFileNameWithoutExtension(f);
                            var model = ReadEnvValue(f, "ANTHROPIC_MODEL") ?? name;
                            profiles.Add(new { id = name, name = name, model = model });
                        }
                    }

                    var repoRoot = _repoRoot;
                    string activePath = null;
                    if (!string.IsNullOrEmpty(repoRoot))
                        activePath = Path.Combine(repoRoot, ".claude", "active-profile");
                    if (activePath == null || !File.Exists(activePath))
                        activePath = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                            ".claude", "ide-profile.active");
                    if (File.Exists(activePath))
                    {
                        activeProfile = File.ReadAllText(activePath).Trim();
                    }

                    var msg = $"{{\"type\":\"model_profiles\",\"profiles\":{JsonConvert.SerializeObject(profiles)},\"active\":\"{activeProfile ?? ""}\"}}";
                    PostMessageToWebview(msg);
                }
                catch (Exception ex)
                {
                    Services.Logger.Error($"SendModelProfiles error: {ex.Message}");
                }
            });
        }

        private async void ApplyModelProfile(string profileId)
        {
            try
            {
                var profilesDir = FindProfilesDir();
                var envPath = Path.Combine(profilesDir, profileId + ".env");
                if (!File.Exists(envPath))
                {
                    Services.Logger.Warn($"ApplyModelProfile: env file not found: {envPath}");
                    return;
                }

                var profileEnv = File.ReadAllText(envPath, Encoding.UTF8);
                var envDict = ParseEnvContent(profileEnv);
                var repoRoot = _repoRoot;

                if (!string.IsNullOrEmpty(repoRoot))
                {
                    var claudeDir = Path.Combine(repoRoot, ".claude");
                    Directory.CreateDirectory(claudeDir);

                    // Write env section to project-level .claude/settings.local.json
                    var localSettingsPath = Path.Combine(claudeDir, "settings.local.json");
                    var localSettings = new Dictionary<string, object>();
                    try { localSettings = JsonConvert.DeserializeObject<Dictionary<string, object>>(File.ReadAllText(localSettingsPath, Encoding.UTF8)); } catch { }
                    if (!localSettings.ContainsKey("env") || !(localSettings["env"] is Dictionary<string, object>))
                        localSettings["env"] = new Dictionary<string, object>();
                    var envSection = (Dictionary<string, object>)localSettings["env"];
                    foreach (var key in PROFILE_MANAGED_KEYS) envSection.Remove(key);
                    foreach (var kv in envDict) envSection[kv.Key] = kv.Value;
                    File.WriteAllText(localSettingsPath, JsonConvert.SerializeObject(localSettings, Formatting.Indented) + "\n", Encoding.UTF8);

                    // Write active profile marker
                    File.WriteAllText(Path.Combine(claudeDir, "active-profile"), profileId, Encoding.UTF8);
                    Services.Logger.Info($"ApplyModelProfile: wrote {localSettingsPath}");
                }

                PostMessageToWebview($"{{\"type\":\"status\",\"status\":\"restarting\"}}");

                // Interrupt + restart backend with new env
                if (_wsClient?.IsConnected == true)
                {
                    _wsClient.Send("{\"type\":\"interrupt\"}");
                }

                if (_processManager != null)
                {
                    await _processManager.RestartAsync();

                    // Reconnect WebSocket to the new port
                    _wsClient?.Dispose();
                    if (_processManager.WebSocketPort.HasValue)
                    {
                        _wsClient = new Services.WebSocketClient(_processManager.WebSocketUrl);
                        _wsClient.MessageReceived += (s, json) => PostMessageToWebview(json);
                        _wsClient.StatusChanged += (s, status) =>
                        {
                            PostMessageToWebview($"{{\"type\":\"status\",\"status\":\"{EscapeJson(status)}\"}}");
                        };
                        await _wsClient.ConnectAsync();
                        FlushOutgoingQueue();
                    }
                }

                PostMessageToWebview($"{{\"type\":\"model_profile_changed\",\"profile\":\"{profileId}\",\"model\":\"{EscapeJson(ReadEnvValue(envPath, "ANTHROPIC_MODEL") ?? ReadEnvValue(envPath, "ANTHROPIC_DEFAULT_SONNET_MODEL") ?? "")}\"}}");
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"ApplyModelProfile error: {ex.Message}");
            }
        }

        private string FindProfilesDir()
        {
            // Use repo root derived from script path (accurate even in Exp instance)
            var repoRoot = _repoRoot;
            if (string.IsNullOrEmpty(repoRoot))
            {
                // Fallback: walk from assembly location
                var assemblyDir = Path.GetDirectoryName(typeof(ClaudeChatWindowControl).Assembly.Location);
                repoRoot = Path.GetFullPath(Path.Combine(assemblyDir ?? ".", "..", "..", "..", "..", ".."));
            }
            Services.Logger.Info($"FindProfilesDir: repoRoot={repoRoot}");
            var dir = Path.Combine(repoRoot, ".env.profiles");
            if (Directory.Exists(dir)) return dir;

            // Priority 2: user home (global profiles created by claude-profile / gui-profile.py)
            var homeDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".claude", ".env.profiles");
            if (Directory.Exists(homeDir)) return homeDir;

            var fallback = Path.Combine(repoRoot, "env.profiles");
            Services.Logger.Info($"FindProfilesDir: .env.profiles exists={Directory.Exists(dir)}, fallback={fallback} exists={Directory.Exists(fallback)}");
            return fallback;
        }

        private static readonly string[] PROFILE_MANAGED_KEYS = {
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION",
            "API_TIMEOUT_MS", "MAX_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_TELEMETRY",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
            "CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD",
            "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"
        };

        private static Dictionary<string, string> ParseEnvContent(string content)
        {
            var result = new Dictionary<string, string>();
            foreach (var rawLine in content.Split('\n'))
            {
                var line = rawLine.Trim();
                if (line.StartsWith("#") || string.IsNullOrEmpty(line)) continue;
                var eq = line.IndexOf('=');
                if (eq <= 0) continue;
                result[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
            return result;
        }

        private static string ReadEnvValue(string filePath, string key)
        {
            try
            {
                foreach (var line in File.ReadAllLines(filePath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.StartsWith("#") || string.IsNullOrEmpty(trimmed)) continue;
                    var eq = trimmed.IndexOf('=');
                    if (eq > 0 && trimmed.Substring(0, eq).Trim() == key)
                    {
                        return trimmed.Substring(eq + 1).Trim();
                    }
                }
            }
            catch { }
            return null;
        }

        private string BuildInlinedHtml()
        {
            var webviewPath = GetWebviewPath();
            var template = File.ReadAllText(Path.Combine(webviewPath, "template-wv2.html"), Encoding.UTF8);

            // Inline CSS: <link rel="stylesheet" href="xxx"> → <style>...</style>
            template = System.Text.RegularExpressions.Regex.Replace(template,
                @"<link\s+rel=""stylesheet""\s+href=""([^""]+)""\s*/?>",
                match =>
                {
                    var cssPath = Path.Combine(webviewPath, match.Groups[1].Value);
                    if (File.Exists(cssPath))
                        return $"<style>{File.ReadAllText(cssPath, Encoding.UTF8)}</style>";
                    Services.Logger.Warn($"CSS not found: {cssPath}");
                    return match.Value;
                });

            // Inline JS: <script src="xxx"></script> → <script>...</script>
            template = System.Text.RegularExpressions.Regex.Replace(template,
                @"<script\s+src=""([^""]+)""\s*>\s*</script>",
                match =>
                {
                    var jsPath = Path.Combine(webviewPath, match.Groups[1].Value);
                    if (File.Exists(jsPath))
                        return $"<script>{File.ReadAllText(jsPath, Encoding.UTF8)}</script>";
                    Services.Logger.Warn($"JS not found: {jsPath}");
                    return match.Value;
                });

            // Inject locale data before </head>
            var localeJson = LoadLocaleData();
            var localeScript = $"<script>window.__localeData = {localeJson};" +
                "function __t(key,params){var val=(window.__localeData||{})[key];" +
                "if(!val)return key;if(params){for(var k in params){" +
                "if(params.hasOwnProperty(k))val=val.replace(new RegExp('{'+k+'}','g'),String(params[k]));" +
                "}}return val;}</script>";
            template = template.Replace("</head>", localeScript + "</head>");

            return template;
        }

        // ── Quick Commands ──────────────────────────────────────────────────

        private void SendQuickCommands()
        {
            var qcPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".claude", "quick-cmds.json");
            string qcJson = "[]";
            try
            {
                if (File.Exists(qcPath))
                    qcJson = File.ReadAllText(qcPath, Encoding.UTF8);
            }
            catch { }
            PostMessageToWebview($"{{\"type\":\"quick_cmds_data\",\"commands\":{qcJson}}}");
        }

        private void SaveQuickCommands(JToken root)
        {
            var cmds = root["commands"];
            if (cmds != null)
            {
                var qcPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".claude", "quick-cmds.json");
                try
                {
                    var dir = Path.GetDirectoryName(qcPath);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                        Directory.CreateDirectory(dir);
                    File.WriteAllText(qcPath, cmds.ToString(), Encoding.UTF8);
                    PostMessageToWebview("{\"type\":\"quick_cmds_saved\"}");
                }
                catch (Exception ex)
                {
                    PostMessageToWebview($"{{\"type\":\"quick_cmds_error\",\"error\":\"{EscapeJson(ex.Message)}\"}}");
                }
            }
        }

        // ── File Content & Workspace ───────────────────────────────────────

        private void SendFileContent(string filePath, bool isDir)
        {
            try
            {
                if (string.IsNullOrEmpty(filePath))
                {
                    PostMessageToWebview($"{{\"type\":\"file_content\",\"path\":\"\",\"content\":\"\",\"isDir\":{isDir.ToString().ToLower()}}}");
                    return;
                }
                if (isDir)
                {
                    var entries = Directory.Exists(filePath)
                        ? Directory.GetFileSystemEntries(filePath)
                        : new string[0];
                    PostMessageToWebview($"{{\"type\":\"file_content\",\"path\":\"{EscapeJson(filePath)}\",\"content\":\"{EscapeJson(string.Join("\n", entries))}\",\"isDir\":true}}");
                }
                else
                {
                    var content = File.Exists(filePath) ? File.ReadAllText(filePath, Encoding.UTF8) : "";
                    PostMessageToWebview($"{{\"type\":\"file_content\",\"path\":\"{EscapeJson(filePath)}\",\"content\":\"{EscapeJson(content)}\",\"isDir\":false}}");
                }
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"SendFileContent error: {ex.Message}");
            }
        }

        private void SendWorkspaceFiles()
        {
            // Get DTE on UI thread, then offload filesystem traversal
            string workspacePath = null;
            try
            {
                var dte = (EnvDTE80.DTE2)Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE));
                if (dte?.Solution != null && !string.IsNullOrEmpty(dte.Solution.FullName))
                    workspacePath = Path.GetDirectoryName(dte.Solution.FullName);
            }
            catch { }

            if (string.IsNullOrEmpty(workspacePath) || !Directory.Exists(workspacePath))
            {
                PostMessageToWebview("{\"type\":\"workspace_files\",\"files\":[]}");
                return;
            }

            var wsPath = workspacePath; // capture for closure
            System.Threading.Tasks.Task.Run(() =>
            {
                try
                {
                    var files = new System.Collections.Generic.List<string>();
                    CollectFiles(wsPath, files, 200);
                    var tree = BuildFileTree(files);
                    var json = JsonConvert.SerializeObject(new { type = "workspace_files", tree });
                    PostMessageToWebview(json);
                }
                catch (Exception ex)
                {
                    Services.Logger.Error($"SendWorkspaceFiles error: {ex.Message}");
                }
            });
        }

        private void CollectFiles(string dir, System.Collections.Generic.List<string> files, int max)
        {
            if (files.Count >= max) return;
            try
            {
                // Collect directories first so top-level structure is always visible,
                // then files, then recurse into subdirectories
                var entries = Directory.GetFileSystemEntries(dir);
                var subdirs = new System.Collections.Generic.List<string>();
                foreach (var entry in entries)
                {
                    var name = Path.GetFileName(entry);
                    if (name.StartsWith(".") || name == "node_modules" || name == "obj" || name == "bin") continue;
                    if (File.Exists(entry))
                    {
                        if (files.Count < max)
                            files.Add(entry.Substring(dir.Length).TrimStart(Path.DirectorySeparatorChar));
                    }
                    else if (Directory.Exists(entry))
                    {
                        subdirs.Add(entry);
                    }
                }
                // Add empty dirs as entries, recurse into non-empty ones
                foreach (var sd in subdirs)
                {
                    if (files.Count >= max) return;
                    var relPath = sd.Substring(dir.Length).TrimStart(Path.DirectorySeparatorChar);
                    files.Add(relPath + Path.DirectorySeparatorChar); // trailing sep marks as dir
                    CollectFiles(sd, files, max);
                }
            }
            catch { /* permission errors */ }
        }

        /// <summary>
        /// Converts a flat list of relative file paths into a tree for the file picker UI.
        /// Each node: { name, path, isDir, children? }
        /// </summary>
        private static System.Collections.Generic.List<object> BuildFileTree(
            System.Collections.Generic.List<string> files)
        {
            var root = new System.Collections.Generic.Dictionary<
                string, System.Collections.Generic.Dictionary<string, object>>(
                StringComparer.OrdinalIgnoreCase);

            foreach (var file in files)
            {
                // Trim trailing separator added by CollectFiles to mark empty dirs
                var isExplicitDir = file.EndsWith("/") || file.EndsWith("\\");
                var cleanPath = isExplicitDir ? file.Substring(0, file.Length - 1) : file;
                var parts = cleanPath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var current = root;
                var pathSoFar = "";

                for (var i = 0; i < parts.Length; i++)
                {
                    var isDir = isExplicitDir ? i == parts.Length - 1 : i < parts.Length - 1;
                    var name = parts[i];
                    pathSoFar = i == 0 ? name : pathSoFar + "/" + name;

                    if (!current.TryGetValue(name, out var node))
                    {
                        node = new System.Collections.Generic.Dictionary<string, object>
                        {
                            { "name", name },
                            { "path", pathSoFar },
                            { "isDir", isDir },
                        };
                        if (isDir)
                            node["children"] = new System.Collections.Generic.Dictionary<
                                string, System.Collections.Generic.Dictionary<string, object>>(
                                StringComparer.OrdinalIgnoreCase);
                        current[name] = node;
                    }

                    if (isDir)
                        current = (System.Collections.Generic.Dictionary<
                            string, System.Collections.Generic.Dictionary<string, object>>)node["children"];
                }
            }

            // Convert nested dicts to lists of node objects
            return ConvertTreeNodes(root);
        }

        private static System.Collections.Generic.List<object> ConvertTreeNodes(
            System.Collections.Generic.Dictionary<
                string, System.Collections.Generic.Dictionary<string, object>> nodes)
        {
            var result = new System.Collections.Generic.List<object>();
            foreach (var kvp in nodes)
            {
                var node = new System.Collections.Generic.Dictionary<string, object>(kvp.Value);
                if (node.TryGetValue("children", out var children) &&
                    children is System.Collections.Generic.Dictionary<
                        string, System.Collections.Generic.Dictionary<string, object>> childDict)
                {
                    node["children"] = ConvertTreeNodes(childDict);
                }
                result.Add(node);
            }
            // Sort: directories first, then alphabetically
            result.Sort((a, b) =>
            {
                var aDict = (System.Collections.Generic.Dictionary<string, object>)a;
                var bDict = (System.Collections.Generic.Dictionary<string, object>)b;
                var aIsDir = (bool)aDict["isDir"];
                var bIsDir = (bool)bDict["isDir"];
                if (aIsDir != bIsDir) return aIsDir ? -1 : 1;
                return string.Compare(
                    (string)aDict["name"], (string)bDict["name"],
                    StringComparison.OrdinalIgnoreCase);
            });
            return result;
        }

        private void FlushOutgoingQueue()
        {
            if (_wsClient?.IsConnected != true) return;
            var count = 0;
            while (_outgoingQueue.TryDequeue(out var msg))
            {
                _wsClient.Send(msg);
                count++;
            }
            if (count > 0)
                Services.Logger.Info($"Flushed {count} queued messages to backend");
        }

        // ── Helpers ───────────────────────────────────────────────────────

        private string FindIdeScript()
        {
            var scripts = new[] { "claude-ide.cmd", "claude-ide", "claude-ide.bat" };
            Services.Logger.Info("FindIdeScript: searching...");

            // 1. Options CLI Path (reads the registry value saved by ClaudeOptionsPage)
            var cliPath = ReadOptionsCliPath();
            Services.Logger.Info($"FindIdeScript: registry CliPath={cliPath ?? "(null)"}");
            if (!string.IsNullOrEmpty(cliPath) && File.Exists(cliPath))
            {
                Services.Logger.Info($"FindIdeScript: FOUND via registry: {cliPath}");
                return cliPath;
            }

            // 2. repo root bin
            var assemblyDir = Path.GetDirectoryName(typeof(ClaudeChatWindowControl).Assembly.Location);
            var repoRoot = Path.GetFullPath(Path.Combine(assemblyDir ?? ".", "..", "..", "..", "..", ".."));
            Services.Logger.Info($"FindIdeScript: assemblyDir={assemblyDir}, repoRoot={repoRoot}");
            foreach (var script in scripts)
            {
                var full = Path.Combine(repoRoot, "bin", script);
                Services.Logger.Info($"FindIdeScript: checking repo: {full} -> {File.Exists(full)}");
                if (File.Exists(full))
                {
                    Services.Logger.Info($"FindIdeScript: FOUND via repo: {full}");
                    return full;
                }
            }

            // 3. PATH
            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "(null)";
            Services.Logger.Info($"FindIdeScript: PATH ({pathEnv.Split(';').Length} entries):");
            foreach (var entry in pathEnv.Split(';'))
            {
                if (!string.IsNullOrWhiteSpace(entry))
                    Services.Logger.Info($"  -> '{entry}'");
            }
            if (!string.IsNullOrEmpty(pathEnv))
            {
                foreach (var dir in pathEnv.Split(';'))
                {
                    foreach (var script in scripts)
                    {
                        var full = Path.Combine(dir.Trim(), script);
                        if (File.Exists(full))
                        {
                            Services.Logger.Info($"FindIdeScript: FOUND via PATH: {full}");
                            return full;
                        }
                    }
                }
            }
            Services.Logger.Error("FindIdeScript: NOT FOUND — all searches exhausted");
            return null;
        }

        private static string ReadOptionsCliPath()
        {
            try
            {
                // VS stores DialogPage values under:
                // HKCU\Software\Microsoft\VisualStudio\<version>Exp\AutomationProperties\<Category>\<Page>
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\VisualStudio"))
                {
                    if (key == null) return null;
                    // Find the instance with "Exp" suffix
                    foreach (var sub in key.GetSubKeyNames())
                    {
                        if (!sub.EndsWith("Exp")) continue;
                        using (var instKey = key.OpenSubKey(sub))
                        {
                            if (instKey == null) continue;
                            var autoKey = instKey.OpenSubKey(
                                @"AutomationProperties\Claude Code\General");
                            if (autoKey != null)
                            {
                                var val = autoKey.GetValue("CliPath") as string;
                                if (!string.IsNullOrEmpty(val)) return val;
                            }
                        }
                    }
                }
            }
            catch { /* registry access may fail */ }
            return null;
        }

        private static string GetWebviewPath()
        {
            var assemblyDir = Path.GetDirectoryName(typeof(ClaudeChatWindowControl).Assembly.Location);
            return Path.Combine(assemblyDir ?? ".", "media", "webview");
        }

        private static string LoadLocaleData()
        {
            var webviewPath = GetWebviewPath();

            // Read language from VS options, fall back to auto-detect
            var lang = ReadOptionsLanguage();
            if (string.IsNullOrEmpty(lang) || lang == "auto")
            {
                // Try zh-cn first if the file exists (most VS users in China),
                // then fall back to English
                lang = File.Exists(Path.Combine(webviewPath, "zh-cn.json"))
                    || File.Exists(Path.Combine(webviewPath, "locales", "zh-cn.json"))
                    ? "zh-cn" : "en";
            }

            // Try selected locale, fall back to English
            foreach (var loc in new[] { lang, "en" })
            {
                foreach (var baseDir in new[] { webviewPath, Path.Combine(webviewPath, "locales") })
                {
                    var p = Path.Combine(baseDir, loc + ".json");
                    try
                    {
                        if (File.Exists(p)) return File.ReadAllText(p, Encoding.UTF8);
                    }
                    catch { }
                }
            }
            return "{}";
        }

        /// <summary>
        /// Reads the Language option from the VS options page registry key.
        /// </summary>
        private static string ReadOptionsLanguage()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\VisualStudio"))
                {
                    if (key == null) return null;
                    foreach (var sub in key.GetSubKeyNames())
                    {
                        if (!sub.EndsWith("Exp")) continue;
                        using (var instKey = key.OpenSubKey(sub))
                        {
                            if (instKey == null) continue;
                            var autoKey = instKey.OpenSubKey(
                                @"AutomationProperties\Claude Code\General");
                            if (autoKey != null)
                            {
                                var val = autoKey.GetValue("Language") as string;
                                if (!string.IsNullOrEmpty(val)) return val;
                            }
                        }
                    }
                }
            }
            catch { }
            return null;
        }

        private static string EscapeJson(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
        }

        // ── Bridge Poll ──────────────────────────────────────────────────

        private void OnBridgePoll(object sender, EventArgs e)
        {
            if (_nativeBridge == null) return;
            // Drain all queued messages from the native JS bridge
            while (_nativeBridge.TryDequeue(out var json))
            {
                Services.Logger.Info($"NativeBridge: received message");
                ProcessMessage(json);
            }
        }

        private void ProcessMessage(string json)
        {
            try
            {
                var logPreview = json ?? "(null)";
                if (logPreview.Length > 200) logPreview = logPreview.Substring(0, 200) + "...";
                Services.Logger.Info($"ProcessMessage: {logPreview}");

                if (string.IsNullOrEmpty(json)) return;

                JObject root;
                try
                {
                    root = JObject.Parse(json);
                }
                catch
                {
                    return; // not valid JSON — ignore
                }
                if (root.Type != JTokenType.Object) return;

                var type = root["type"]?.Value<string>();
                if (type == null) return;

                // ── Diagnostic: bridge test ──────────────────────────────
                if (type == "diag_bridge_ok")
                {
                    Services.Logger.Info("WebView bridge verified OK via native bridge");
                    return;
                }

                // ── ready: backend lifecycle ─────────────────────────────
                if (type == "ready")
                {
                    Services.Logger.Info("WebView READY — starting backend...");
                    _isReady = true;
                    StartBackendAsync();
                    return;
                }

                // ── Locally handled messages ────────────────────────────
                if (type == "open_file")
                {
                    var rawPath = root["path"]?.Value<string>();
                    if (!string.IsNullOrEmpty(rawPath))
                    {
                        var path = rawPath;
                        if (!System.IO.Path.IsPathRooted(path))
                        {
                            try
                            {
                                var dte2 = (EnvDTE80.DTE2)Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE));
                                var solDir = System.IO.Path.GetDirectoryName(dte2?.Solution?.FullName);
                                if (!string.IsNullOrEmpty(solDir))
                                    path = System.IO.Path.Combine(solDir, rawPath);
                            }
                            catch { }
                        }
                        if (File.Exists(path))
                        {
                            System.Threading.Tasks.Task.Run(() =>
                            {
                                try
                                {
                                    var dte = (EnvDTE80.DTE2)Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE));
                                    dte?.ItemOperations.OpenFile(path, EnvDTE.Constants.vsViewKindTextView);
                                }
                                catch { /* fallback to external open */ }
                            });
                        }
                    }
                    return;
                }

                if (type == "request_model_profiles")
                {
                    SendModelProfiles();
                    return;
                }

                if (type == "set_model_profile")
                {
                    var profileId = root["profileId"]?.Value<string>()
                                 ?? root["profile"]?.Value<string>();
                    if (!string.IsNullOrEmpty(profileId))
                        ApplyModelProfile(profileId);
                    return;
                }

                if (type == "get_quick_cmds")
                {
                    SendQuickCommands();
                    return;
                }

                if (type == "save_quick_cmds")
                {
                    SaveQuickCommands(root);
                    return;
                }

                if (type == "request_file_content")
                {
                    var filePath = root["path"]?.Value<string>();
                    var isDir = root["isDir"]?.Value<bool>() ?? false;
                    SendFileContent(filePath, isDir);
                    return;
                }

                if (type == "request_file_pick")
                {
                    SendWorkspaceFiles();
                    return;
                }

                // ── Transformations before forwarding ────────────────────
                if (type == "user_message")
                {
                    ForwardUserMessage(root);
                    return;
                }

                if (type == "control_response")
                {
                    ForwardControlResponse(root);
                    return;
                }

                // ── Pass-through to Bun backend (background to avoid blocking UI) ──
                if (_wsClient?.IsConnected == true)
                {
                    var msg = json;
                    System.Threading.Tasks.Task.Run(() => _wsClient.Send(msg));
                }
                else
                {
                    if (_outgoingQueue.Count < 50)
                    {
                        _outgoingQueue.Enqueue(json);
                        Services.Logger.Info($"Queued message (backend not ready): type={type}, queueSize={_outgoingQueue.Count}");
                    }
                    else
                    {
                        Services.Logger.Warn($"Queue full, message dropped: type={type}");
                    }
                }
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"ProcessMessage: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // ── Cleanup ──────────────────────────────────────────────────────

        public void Shutdown()
        {
            _bridgePollTimer?.Stop();
            _wsClient?.Dispose();
            _processManager?.Dispose();
        }
    }
}
