using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace ClaudeCodeVS.Options
{
    /// <summary>
    /// Claude Code settings page in Tools → Options.
    /// Replaces vscode.workspace.getConfiguration('claudeCode') settings.
    /// </summary>
    [Guid("E1F2A3B4-C5D6-7890-EF01-234567890ABC")]
    public class ClaudeOptionsPage : DialogPage
    {
        private string _cliPath = string.Empty;
        private string _language = "auto";

        [Category("General")]
        [DisplayName("CLI Path")]
        [Description("Path to the Claude Code IDE script (bin/claude-ide or bin/claude-ide.cmd). Leave empty for auto-detection.")]
        public string CliPath
        {
            get => _cliPath;
            set => _cliPath = value;
        }

        [Category("General")]
        [DisplayName("Language")]
        [Description("UI language. 'auto' follows VS language, or choose 'en' / 'zh-cn'.")]
        [DefaultValue("auto")]
        [TypeConverter(typeof(LanguageConverter))]
        public string Language
        {
            get => _language;
            set => _language = value;
        }

        protected override void OnApply(PageApplyEventArgs e)
        {
            base.OnApply(e);
            // TODO: notify running backend of config changes
        }
    }

    /// <summary>
    /// Dropdown for language selection in the options page.
    /// </summary>
    internal class LanguageConverter : StringConverter
    {
        public override bool GetStandardValuesSupported(ITypeDescriptorContext context)
            => true;

        public override bool GetStandardValuesExclusive(ITypeDescriptorContext context)
            => true;

        public override StandardValuesCollection GetStandardValues(ITypeDescriptorContext context)
            => new StandardValuesCollection(new[] { "auto", "en", "zh-cn" });
    }
}
