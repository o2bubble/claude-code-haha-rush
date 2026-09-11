using System;
using System.ComponentModel.Design;
using System.IO;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json;

namespace ClaudeCodeVS.Commands
{
    /// <summary>
    /// Right-click context menu command: adds current text editor selection
    /// as a reference to the Claude Code chat input.
    ///
    /// Mirrors the VS Code extension's claude-code.sendSelection command:
    /// sends fill_input with "[file:line]" text + selection metadata chip.
    /// </summary>
    internal sealed class SendSelectionToChatCommand
    {
        public const int CommandId = 0x0200;
        public static readonly Guid CommandSet = new Guid("B1C2D3E4-F5A6-7890-BCDE-F12345678901");

        public static void Initialize(AsyncPackage package)
        {
            var commandService = (IMenuCommandService)package.GetServiceAsync(typeof(IMenuCommandService)).Result;
            if (commandService == null) return;

            var cmdId = new CommandID(CommandSet, CommandId);
            var cmd = new MenuCommand(
                (s, e) => Execute(package),
                cmdId);
            commandService.AddCommand(cmd);
        }

        private static void Execute(AsyncPackage package)
        {
            package.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                var dte = (EnvDTE80.DTE2)Package.GetGlobalService(typeof(EnvDTE.DTE));
                if (dte?.ActiveDocument == null) return;

                // Get selection via Document.Object("TextDocument") → Selection
                EnvDTE.TextSelection sel = null;
                try
                {
                    var textDoc = dte.ActiveDocument.Object() as EnvDTE.TextDocument;
                    sel = textDoc?.Selection as EnvDTE.TextSelection;
                }
                catch { }

                if (sel == null)
                {
                    try { sel = dte.ActiveDocument.Selection as EnvDTE.TextSelection; } catch { }
                }

                if (sel == null || sel.IsEmpty) return;

                // Line numbers: 1-based for human readability (match VS Code)
                var startLine = sel.TopLine;
                var endLine = sel.BottomLine;

                // Compute relative path against solution directory
                var absPath = dte.ActiveDocument.FullName;
                string relativePath = absPath;
                try
                {
                    var solDir = Path.GetDirectoryName(dte.Solution.FullName);
                    if (solDir != null && absPath.StartsWith(solDir, StringComparison.OrdinalIgnoreCase))
                        relativePath = absPath.Substring(solDir.Length).TrimStart(Path.DirectorySeparatorChar);
                }
                catch { }

                var lineRef = startLine == endLine ? $"{startLine}" : $"{startLine}-{endLine}";

                // Send fill_input → WebView merges text into input and adds a selection chip
                var json = JsonConvert.SerializeObject(new
                {
                    type = "fill_input",
                    text = $"[{relativePath}:{lineRef}]",
                    selection = new { filePath = relativePath, startLine, endLine },
                });

                // Find tool window, send message, and bring to foreground
                var window = await package.FindToolWindowAsync(
                    typeof(ToolWindows.ClaudeChatWindow), 0, false, package.DisposalToken);
                if (window is ToolWindows.ClaudeChatWindow chatWindow)
                {
                    chatWindow.SendToWebView(json);
                }

                // Show the tool window (match VS Code's chatProvider.show())
                if (window != null)
                {
                    var windowFrame = (Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame)window.Frame;
                    Microsoft.VisualStudio.ErrorHandler.ThrowOnFailure(windowFrame.Show());
                }
            });
        }
    }
}
