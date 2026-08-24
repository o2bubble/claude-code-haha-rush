using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.IO;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json;

namespace ClaudeCodeVS.Commands
{
    /// <summary>
    /// Solution Explorer context menu command: adds selected files/folders
    /// to the Claude Code chat as context.
    ///
    /// Mirrors VS Code extension's claude-code.addToChat command:
    /// collects selected solution items, builds file metadata (path, language,
    /// isDir), and sends "file_picked" message to the WebView.
    /// </summary>
    internal sealed class AddToChatCommand
    {
        public const int AddToChatId = 0x0500;
        public const int AddFolderToChatId = 0x0501;
        public const int AddProjectToChatId = 0x0502;
        public const int AddMultiToChatId = 0x0503;
        public static readonly Guid CommandSet = new Guid("B1C2D3E4-F5A6-7890-BCDE-F12345678901");

        public static void Initialize(AsyncPackage package)
        {
            var commandService = (IMenuCommandService)package.GetServiceAsync(typeof(IMenuCommandService)).Result;
            if (commandService == null) return;

            var handler = new EventHandler((s, e) => Execute(package));

            // Register all four menu commands (files, folders, projects, multi-select)
            foreach (var cmdId in new[] { AddToChatId, AddFolderToChatId, AddProjectToChatId, AddMultiToChatId })
            {
                var cmd = new MenuCommand(handler, new CommandID(CommandSet, cmdId));
                commandService.AddCommand(cmd);
            }
        }

        private static void Execute(AsyncPackage package)
        {
            package.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var dte = (EnvDTE80.DTE2)Package.GetGlobalService(typeof(EnvDTE.DTE));
                if (dte == null) return;

                var files = new List<object>();
                string solutionDir = null;
                try { solutionDir = Path.GetDirectoryName(dte.Solution?.FullName); } catch { }

                // Collect selected items from Solution Explorer
                var selectedItems = dte.SelectedItems as EnvDTE.SelectedItems;
                if (selectedItems != null)
                {
                    foreach (EnvDTE.SelectedItem item in selectedItems)
                    {
                        var projItem = item.ProjectItem;
                        if (projItem == null) continue;

                        var fi = projItem.Properties?.Item("FullPath");
                        var fullPath = fi?.Value as string;
                        if (string.IsNullOrEmpty(fullPath)) continue;

                        // Compute relative path against solution directory
                        var displayPath = fullPath;
                        if (solutionDir != null && fullPath.StartsWith(solutionDir, StringComparison.OrdinalIgnoreCase))
                            displayPath = fullPath.Substring(solutionDir.Length).TrimStart(Path.DirectorySeparatorChar);

                        var isDir = Directory.Exists(fullPath);
                        if (isDir)
                        {
                            files.Add(new { path = displayPath, isDir = true });
                        }
                        else
                        {
                            var ext = Path.GetExtension(fullPath).TrimStart('.').ToLowerInvariant();
                            files.Add(new { path = displayPath, language = ext });
                        }
                    }
                }

                if (files.Count == 0) return;

                var json = JsonConvert.SerializeObject(new
                {
                    type = "file_picked",
                    files,
                });

                // Send to WebView and show the tool window
                var window = await package.FindToolWindowAsync(
                    typeof(ToolWindows.ClaudeChatWindow), 0, false, package.DisposalToken);
                if (window is ToolWindows.ClaudeChatWindow chatWindow)
                {
                    chatWindow.SendToWebView(json);
                }

                if (window != null)
                {
                    var windowFrame = (Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame)window.Frame;
                    Microsoft.VisualStudio.ErrorHandler.ThrowOnFailure(windowFrame.Show());
                }
            });
        }
    }
}
