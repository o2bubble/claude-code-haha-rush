using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using System.Threading;
using ClaudeCodeVS.Messages;

namespace ClaudeCodeVS.Services
{
    /// <summary>
    /// Collects IDE context (active document, selection, diagnostics) and
    /// sends it to the Bun backend via WebSocket.
    ///
    /// Ported from extensions/vscode/src/contextProvider.ts.
    /// VS equivalents:
    ///   vscode.window.activeTextEditor     → IWpfTextView (via MEF listener)
    ///   vscode.window.visibleTextEditors   → Enumerate open ITextDocument
    ///   vscode.workspace.asRelativePath    → Path.GetRelativePath(solutionDir, filePath)
    ///   vscode.languages.getDiagnostics    → Error List / IVsSolutionBuildManager
    /// </summary>
    public class ContextProvider : IDisposable
    {
        private readonly Func<bool> _enabled;
        private readonly Action<string> _sendToBackend;  // sends JSON to WebSocket
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        private int _maxFilesInContext = 5;
        private System.Timers.Timer _debounceTimer;

        public ContextProvider(Func<bool> enabled, Action<string> sendToBackend)
        {
            _enabled = enabled;
            _sendToBackend = sendToBackend;
        }

        /// <summary>
        /// Call from IWpfTextViewConnectionListener when a text view is connected.
        /// This replaces vscode.window.onDidChangeActiveTextEditor.
        /// </summary>
        public void OnTextViewActivated(Microsoft.VisualStudio.Text.Editor.IWpfTextView textView)
        {
            var doc = GetTextDocument(textView);
            if (doc == null) return;

            ScheduleContextUpdate();
        }

        /// <summary>
        /// Call from ITextSelection.SelectionChanged.
        /// </summary>
        public void OnSelectionChanged()
        {
            ScheduleContextUpdate();
        }

        /// <summary>
        /// Call from ITextBuffer.Changed on visible documents.
        /// </summary>
        public void OnDocumentChanged()
        {
            ScheduleContextUpdate();
        }

        /// <summary>
        /// Call from a diagnostics change event (Error List or Roslyn listener).
        /// </summary>
        public void OnDiagnosticsChanged()
        {
            ScheduleContextUpdate();
        }

        // ── Context Collection ─────────────────────────────────────────────

        public void SendContext()
        {
            if (_sendToBackend == null) return;

            var context = CollectContext();
            if (context == null) return;

            var json = JsonConvert.SerializeObject(context, new JsonSerializerSettings
            {
                ContractResolver = new CamelCasePropertyNamesContractResolver(),
                NullValueHandling = NullValueHandling.Ignore,
            });
            _sendToBackend(json);
        }

        private IdeContextMessage CollectContext()
        {
            var files = CollectActiveFiles(_maxFilesInContext);
            var selection = CollectSelection();
            var diagnostics = CollectDiagnostics();

            if (files.Count == 0 && selection == null && diagnostics.Count == 0)
                return null;

            return new IdeContextMessage
            {
                Type = MessageTypes.IdeContext,
                Files = files.Count > 0 ? files : null,
                Selection = selection,
                Diagnostics = diagnostics.Count > 0 ? diagnostics : null,
            };
        }

        private List<FileContext> CollectActiveFiles(int maxFiles)
        {
            var result = new List<FileContext>();

            try
            {
                // Use DTE to enumerate open documents
                // var dte = (EnvDTE80.DTE2)ServiceProvider.GetService(typeof(EnvDTE.DTE));
                var dte = GetDTE();
                if (dte == null) return result;

                var activeDoc = dte.ActiveDocument;
                if (activeDoc != null)
                {
                    var content = GetDocumentContent(activeDoc.FullName);
                    if (content != null)
                    {
                        result.Add(new FileContext
                        {
                            Path = activeDoc.FullName,
                            Content = content,
                            Language = activeDoc.Language,
                        });
                    }
                }

                // TODO: Add visible tab documents (not just active)
                // For now, active document is the primary context source
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[ClaudeCodeVS] Context error: {ex.Message}");
            }

            return result;
        }

        private Selection CollectSelection()
        {
            try
            {
                var dte = GetDTE();
                if (dte == null) return null;

                var textSelection = dte.ActiveDocument?.Selection as EnvDTE.TextSelection;
                if (textSelection == null || textSelection.IsEmpty) return null;

                var text = textSelection.Text;
                if (string.IsNullOrEmpty(text)) return null;

                return new Selection
                {
                    Path = dte.ActiveDocument.FullName,
                    StartLine = textSelection.TopLine - 1,       // 1-based → 0-based
                    StartChar = textSelection.TopPoint.LineCharOffset - 1,
                    EndLine = textSelection.BottomLine - 1,
                    EndChar = textSelection.BottomPoint.LineCharOffset - 1,
                    Text = text,
                };
            }
            catch
            {
                return null;
            }
        }

        private List<Messages.Diagnostic> CollectDiagnostics()
        {
            // Simplified: VS diagnostics require Error List Provider integration.
            // For initial release, return empty. Can be enhanced later.
            return new List<Messages.Diagnostic>();
        }

        // ── Helper Methods ────────────────────────────────────────────────

        private void ScheduleContextUpdate()
        {
            if (!_enabled()) return;

            _debounceTimer?.Stop();
            _debounceTimer = new System.Timers.Timer(500) { AutoReset = false };
            _debounceTimer.Elapsed += (s, e) =>
            {
                SendContext();
            };
            _debounceTimer.Start();
        }

        private static EnvDTE80.DTE2 GetDTE()
        {
            try
            {
                return Microsoft.VisualStudio.Shell.Package.GetGlobalService(
                    typeof(EnvDTE.DTE)) as EnvDTE80.DTE2;
            }
            catch
            {
                return null;
            }
        }

        private static string GetDocumentContent(string filePath)
        {
            try
            {
                if (File.Exists(filePath))
                {
                    var content = File.ReadAllText(filePath);
                    // Cap at 100KB to avoid huge payloads
                    if (content.Length > 100 * 1024)
                    {
                        content = content.Substring(0, 100 * 1024) + "\n... (truncated)";
                    }
                    return content;
                }
            }
            catch { }
            return null;
        }

        private static Microsoft.VisualStudio.Text.ITextDocument GetTextDocument(
            Microsoft.VisualStudio.Text.Editor.IWpfTextView textView)
        {
            textView.TextBuffer.Properties.TryGetProperty(
                typeof(Microsoft.VisualStudio.Text.ITextDocument),
                out Microsoft.VisualStudio.Text.ITextDocument doc);
            return doc;
        }

        public void Dispose()
        {
            _cts.Cancel();
            _debounceTimer?.Dispose();
        }
    }
}
