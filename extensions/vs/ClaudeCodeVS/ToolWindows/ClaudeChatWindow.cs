using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;

namespace ClaudeCodeVS.ToolWindows
{
    /// <summary>
    /// Claude Code chat tool window — hosts a WebView2 WPF control.
    /// Maps to extensions/vscode/src/webview/provider.ts in the VS Code extension.
    /// </summary>
    [Guid(WindowGuidString)]
    public class ClaudeChatWindow : ToolWindowPane
    {
        public const string WindowGuidString = "D1E2F3A4-B5C6-7890-DEFA-01234567890A";
        public const string Title = "Claude Code";

        public ClaudeChatWindow() : base(null)
        {
            Caption = Title;
            BitmapImageMoniker = KnownMonikers.StatusInformation;
            Content = new ClaudeChatWindowControl();
        }

        /// <summary>
        /// Public wrapper to send a JSON message to the hosted WebView.
        /// Used by context menu commands (e.g., Send Selection to Chat).
        /// </summary>
        public void SendToWebView(string json)
        {
            var control = Content as ClaudeChatWindowControl;
            control?.SendToWebView(json);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                (Content as ClaudeChatWindowControl)?.Shutdown();
            }
            base.Dispose(disposing);
        }
    }
}
