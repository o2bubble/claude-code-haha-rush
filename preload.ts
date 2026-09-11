const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '2.1.89 (sync:2.1.211)';
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

// Enable streaming idle timeout watchdog by default: abort the stream if no
// chunks arrive for STREAM_IDLE_TIMEOUT_MS (default 90s). Without this, a
// silently dropped streaming connection or unresponsive API can hang the
// session indefinitely (no timeout on Bun's fetch(), no timeout on the SDK's
// stream iteration — the for-await simply stops receiving chunks and waits).
process.env.CLAUDE_ENABLE_STREAM_WATCHDOG ??= 'true';

// API timeout for all requests. This env var is read by the API client
// (claude.ts) for non-streaming fallback timeouts. For streaming requests,
// the SDK's default HTTP timeout (~10min) applies. Set a generous default
// here so slow backends (DeepSeek, custom proxies) have a ceiling.
process.env.API_TIMEOUT_MS ??= '600000'; // 10 minutes

// Restore original CWD saved by bin/claude-haha, so Bun can find
// bunfig.toml in the project root while Claude operates in the user's directory.
if (process.env.ORIGINAL_CWD) {
  try {
    process.chdir(process.env.ORIGINAL_CWD);
  } catch (_) {
    // Ignore if the directory no longer exists
  }
}

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
