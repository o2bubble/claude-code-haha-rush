/**
 * Compiled entrypoint — wraps preload.ts + cli.tsx for bun build --compile.
 * preload.ts can't run before the compiled bundle, so we inline it here.
 */

// ── Inlined preload.ts ─────────────────────────────────────────────────────
const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '2.1.89 (sync:2.1.211)';
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

if (process.env.ORIGINAL_CWD) {
  try { process.chdir(process.env.ORIGINAL_CWD); } catch (_) {}
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

// ── Import original cli entrypoint ─────────────────────────────────────────
// Must use dynamic import: ESM static imports evaluate BEFORE module body,
// so cli.tsx's main() would run before MACRO is set via Object.assign above.
import('./cli.tsx');
