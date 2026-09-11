using System;
using System.ComponentModel.Design;
using Microsoft.VisualStudio.Shell;

namespace ClaudeCodeVS.Commands
{
    /// <summary>
    /// Opens the Claude Code chat tool window.
    /// Equivalent to claude-code.startChat in the VS Code extension.
    /// </summary>
    internal sealed class ShowToolWindowCommand
    {
        public const int CommandId = 0x0100;
        public static readonly Guid CommandSet = new Guid("B1C2D3E4-F5A6-7890-BCDE-F12345678901");

        public static async System.Threading.Tasks.Task InitializeAsync(AsyncPackage package)
        {
            var commandService = (IMenuCommandService)await package.GetServiceAsync(typeof(IMenuCommandService));
            var cmdId = new CommandID(CommandSet, CommandId);
            var cmd = new MenuCommand((s, e) => Execute(package), cmdId);
            commandService.AddCommand(cmd);
        }

        private static void Execute(AsyncPackage package)
        {
            package.JoinableTaskFactory.RunAsync(async () =>
            {
                var window = await package.ShowToolWindowAsync(
                    typeof(ToolWindows.ClaudeChatWindow),
                    0,
                    create: true,
                    cancellationToken: package.DisposalToken);
                if (window == null)
                {
                    throw new NotSupportedException("Cannot create Claude Code tool window");
                }
                var windowFrame = (Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame)window.Frame;
                Microsoft.VisualStudio.ErrorHandler.ThrowOnFailure(windowFrame.Show());
            });
        }
    }
}
