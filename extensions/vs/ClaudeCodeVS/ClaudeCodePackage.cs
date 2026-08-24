using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace ClaudeCodeVS
{
    /// <summary>
    /// Claude Code entry point — registers the chat tool window and commands.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [ProvideAutoLoad(VSConstants.UICONTEXT.NoSolution_string, PackageAutoLoadFlags.BackgroundLoad)]
    [InstalledProductRegistration("#110", "#112", "0.1.0")]
    [ProvideToolWindow(
        typeof(ToolWindows.ClaudeChatWindow),
        Style = VsDockStyle.Float,
        MultiInstances = false)]
    [ProvideOptionPage(typeof(Options.ClaudeOptionsPage), "Claude Code", "General", 101, 106, true)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [Guid(ClaudeCodePackage.PackageGuidString)]
    public sealed class ClaudeCodePackage : AsyncPackage
    {
        public const string PackageGuidString = "1A2B3C4D-5E6F-7890-ABCD-EF0123456789";

        /// <summary>
        /// Called on a background thread. Register commands here.
        /// </summary>
        protected override async Task InitializeAsync(
            CancellationToken cancellationToken,
            IProgress<ServiceProgressData> progress)
        {
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            await Commands.ShowToolWindowCommand.InitializeAsync(this);
            Commands.SendSelectionToChatCommand.Initialize(this);
            Commands.AddToChatCommand.Initialize(this);
        }
    }
}
