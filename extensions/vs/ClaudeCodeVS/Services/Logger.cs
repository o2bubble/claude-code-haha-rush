using System;
using System.IO;

namespace ClaudeCodeVS.Services
{
    /// <summary>
    /// Simple file logger for debugging. Writes to %TEMP%\ClaudeCodeVS.log
    /// </summary>
    public static class Logger
    {
        private static readonly string LogPath = Path.Combine(
            Path.GetTempPath(), "ClaudeCodeVS.log");

        private static readonly object _lock = new object();

        public static void Info(string message)
        {
            Write("INFO", message);
        }

        public static void Error(string message, Exception ex = null)
        {
            Write("ERROR", ex != null ? $"{message}: {ex}" : message);
        }

        public static void Warn(string message)
        {
            Write("WARN", message);
        }

        private static void Write(string level, string message)
        {
            lock (_lock)
            {
                try
                {
                    File.AppendAllText(LogPath,
                        $"{DateTime.Now:HH:mm:ss.fff} [{level}] {message}\n");
                }
                catch { /* logging should never crash */ }
            }
        }

        public static string GetLogPath() => LogPath;
    }
}
