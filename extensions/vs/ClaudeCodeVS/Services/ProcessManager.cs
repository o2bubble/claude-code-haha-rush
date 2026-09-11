using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClaudeCodeVS.Services
{
    /// <summary>
    /// Manages the Bun backend process lifecycle.
    /// Ported from extensions/vscode/src/processManager.ts.
    /// </summary>
    public class ProcessManager : IDisposable
    {
        private const int MaxRestarts = 5;
        private const int InitialRestartDelayMs = 2000;
        private const int MaxRestartDelayMs = 30000;
        private const int PortTimeoutMs = 30000;

        private readonly string _scriptPath;
        private readonly string _repoRoot;
        private Process _process;
        private int _restartCount;
        private int _restartDelay = InitialRestartDelayMs;
        private bool _started;
        private bool _intentionalRestart;

        public int? WebSocketPort { get; private set; }
        public string WebSocketUrl => WebSocketPort.HasValue ? $"ws://127.0.0.1:{WebSocketPort}/ws" : null;
        public bool IsRunning => _process != null && !_process.HasExited;

        public event EventHandler<string> StatusChanged;
        public event EventHandler<string> LogReceived;
        public event EventHandler<Exception> ErrorOccurred;

        public string WorkspacePath { get; set; }

        public ProcessManager(string scriptPath)
        {
            _scriptPath = scriptPath;
            _repoRoot = Path.GetDirectoryName(Path.GetDirectoryName(scriptPath));
        }

        public async Task StartAsync()
        {
            if (_started) return;
            _started = true;
            await SpawnProcessAsync();
        }

        public async Task StopAsync()
        {
            _started = false;
            _restartCount = 0;
            _restartDelay = InitialRestartDelayMs;

            if (_process != null && !_process.HasExited)
            {
                try
                {
                    _process.StandardInput.Close();
                }
                catch { /* ignore */ }

                // SIGTERM → 5s → SIGKILL pattern
                KillProcess(_process.Id);
                await Task.Delay(5000);
                try
                {
                    if (!_process.HasExited)
                    {
                        _process.Kill();
                    }
                }
                catch { /* process may have already exited */ }
            }
            _process = null;
            WebSocketPort = null;
        }

        public async Task RestartAsync()
        {
            _intentionalRestart = true;
            StatusChanged?.Invoke(this, "restarting");

            if (_process != null)
            {
                try
                {
                    _process.StandardInput.Close();
                }
                catch { }
                KillProcess(_process.Id);
                await Task.Delay(5000);
            }
            _process = null;
            WebSocketPort = null;

            await Task.Delay(500);
            _intentionalRestart = false;
            await SpawnProcessAsync();
        }

        public void ResetRestartCount()
        {
            _restartCount = 0;
            _restartDelay = InitialRestartDelayMs;
        }

        // ── Internal ──────────────────────────────────────────────────────────

        private static bool IsWindows => RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

        private async Task SpawnProcessAsync()
        {
            var isCmd = _scriptPath.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                     || _scriptPath.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
            var isPs1 = _scriptPath.EndsWith(".ps1", StringComparison.OrdinalIgnoreCase);

            string command;
            string arguments;

            if (IsWindows && isCmd)
            {
                // Build the command line first: "<script>" --cwd "<workspace>"
                var cmdLine = $"\"{_scriptPath}\"";
                if (!string.IsNullOrEmpty(WorkspacePath))
                {
                    cmdLine += $" --cwd \"{WorkspacePath}\"";
                }
                // /s : predictable quoting — strip first+last " then process remaining
                command = "cmd.exe";
                arguments = $"/s /c \"{cmdLine}\"";
            }
            else if (IsWindows && isPs1)
            {
                command = "pwsh.exe";
                arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{_scriptPath}\"";
                if (!string.IsNullOrEmpty(WorkspacePath))
                {
                    arguments += $" --cwd \"{WorkspacePath}\"";
                }
            }
            else if (IsWindows)
            {
                command = "bash.exe";
                arguments = $"\"{_scriptPath}\"";
                if (!string.IsNullOrEmpty(WorkspacePath))
                {
                    arguments += $" --cwd \"{WorkspacePath}\"";
                }
            }
            else
            {
                command = "bash";
                arguments = $"\"{_scriptPath}\"";
                if (!string.IsNullOrEmpty(WorkspacePath))
                {
                    arguments += $" --cwd \"{WorkspacePath}\"";
                }
            }

            Services.Logger.Info($"PM command: {command} {arguments}");
            LogReceived?.Invoke(this, $"Starting: {command} {arguments} (cwd: {_repoRoot})");
            StatusChanged?.Invoke(this, "starting");

            var psi = new ProcessStartInfo
            {
                FileName = command,
                Arguments = arguments,
                WorkingDirectory = _repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            // Pass workspace path as env var (more reliable than --cwd arg on Windows)
            if (!string.IsNullOrEmpty(WorkspacePath))
            {
                psi.EnvironmentVariables["CLAUDE_CODE_CWD"] = WorkspacePath;
            }

            // Apply saved profile env vars (matches restoreIdeProfile in VS Code extension)
            LoadProfileEnv(psi);
            // Apply shell flag for .cmd files (deprecated: now using cmd.exe /c instead)
            // psi.UseShellExecute is already false from the initializer

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _process = proc;

            // Port discovery from stdout (regex: CLAUDE_CODE_IDE_PORT=<N>)
            var portCts = new CancellationTokenSource(PortTimeoutMs);
            var portTcs = new TaskCompletionSource<int>();

            proc.OutputDataReceived += (sender, e) =>
            {
                if (e.Data == null) return;
                Services.Logger.Info($"PM stdout: {e.Data}");
                var match = System.Text.RegularExpressions.Regex.Match(
                    e.Data, @"CLAUDE_CODE_IDE_PORT=(\d+)");
                if (match.Success)
                {
                    var port = int.Parse(match.Groups[1].Value);
                    WebSocketPort = port;
                    portTcs.TrySetResult(port);
                }
            };

            proc.ErrorDataReceived += (sender, e) =>
            {
                if (e.Data != null)
                {
                    Services.Logger.Info($"PM stderr: {e.Data}");
                    LogReceived?.Invoke(this, e.Data);
                }
            };

            proc.Exited += async (sender, e) =>
            {
                if (_process != proc) return; // stale process
                if (_intentionalRestart) return;

                var exitCode = proc.ExitCode;
                Services.Logger.Info($"PM: Process exited with code {exitCode}");
                LogReceived?.Invoke(this, $"Process exited with code {exitCode}");

                // Ensure no grandchildren survived (cmd.exe → powershell → bun).
                // cmd.exe /c normally waits for the full chain, but rare edge
                // cases can leave orphans — belt-and-suspenders safety net.
                KillProcess(proc.Id);

                if (!_started) return;

                if (exitCode != 0)
                {
                    _restartCount++;
                    if (_restartCount > MaxRestarts)
                    {
                        ErrorOccurred?.Invoke(this,
                            new Exception($"Claude Code crashed {MaxRestarts} times. Restart disabled."));
                        return;
                    }
                }

                StatusChanged?.Invoke(this, $"restarting in {_restartDelay / 1000}s");
                await Task.Delay(_restartDelay);
                _restartDelay = Math.Min(_restartDelay * 2, MaxRestartDelayMs);
                await SpawnProcessAsync();
            };

            try
            {
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                // Wait for port or timeout
                var completed = await Task.WhenAny(portTcs.Task, Task.Delay(PortTimeoutMs));
                if (completed == portTcs.Task && portTcs.Task.Status == TaskStatus.RanToCompletion)
                {
                    var port = portTcs.Task.Result;
                    Services.Logger.Info($"ProcessManager: Claude Code IDE port discovered: {port}");
                    LogReceived?.Invoke(this, $"Claude Code IDE port discovered: {port}");
                    StatusChanged?.Invoke(this, "connected");
                }
                else
                {
                    Services.Logger.Error("ProcessManager: Claude Code did not start within 30s");
                    ErrorOccurred?.Invoke(this,
                        new TimeoutException("Claude Code did not start within 30s. Check claudeCode.cliPath config."));
                }
            }
            catch (Exception ex)
            {
                Services.Logger.Error($"ProcessManager: Failed to start process: {ex.Message}", ex);
                LogReceived?.Invoke(this, $"Failed to start process: {ex.Message}");
                ErrorOccurred?.Invoke(this, ex);
            }
        }

        private void LoadProfileEnv(ProcessStartInfo psi)
        {
            // Chain: project-level → user default → legacy ide-profile.env
            var candidates = new[]
            {
                Path.Combine(_repoRoot, ".claude", "profile.env"),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".claude", "profile.env"),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".claude", "ide-profile.env"),
            };
            foreach (var profileEnvPath in candidates)
            {
                try
                {
                    if (File.Exists(profileEnvPath))
                    {
                        foreach (var line in File.ReadAllLines(profileEnvPath))
                        {
                            var trimmed = line.Trim();
                            if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("#")) continue;
                            var eq = trimmed.IndexOf('=');
                            if (eq > 0)
                            {
                                var key = trimmed.Substring(0, eq).Trim();
                                var value = trimmed.Substring(eq + 1).Trim();
                                psi.EnvironmentVariables[key] = value;
                            }
                        }
                        return; // first found wins
                    }
                }
                catch (Exception ex)
                {
                    Services.Logger.Warn($"LoadProfileEnv: failed to read {profileEnvPath}: {ex.Message}");
                }
            }
        }

        private static void KillProcess(int pid)
        {
            try
            {
                using var killer = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {pid} /T /F",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                killer?.WaitForExit(5000);
            }
            catch { /* process may not exist */ }
        }

        public void Dispose()
        {
            _started = false;

            if (_process != null && !_process.HasExited)
            {
                try
                {
                    _process.StandardInput.Close();
                }
                catch { /* ignore */ }

                var pid = _process.Id;
                var proc = _process;
                _process = null;
                WebSocketPort = null;

                // Offload blocking kill to background thread — Thread.Sleep(2000)
                // on the UI thread will freeze Visual Studio.
                System.Threading.Tasks.Task.Run(() =>
                {
                    KillProcess(pid);
                    System.Threading.Thread.Sleep(2000);
                    try
                    {
                        if (!proc.HasExited)
                        {
                            proc.Kill();
                        }
                    }
                    catch { }
                    proc.Dispose();
                });
            }
            else
            {
                _process?.Dispose();
                _process = null;
                WebSocketPort = null;
            }
        }
    }
}
