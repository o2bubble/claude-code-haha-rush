import { delimiter as pathDelimiter } from 'path'
import { isEnvTruthy } from './envUtils.js'
import { getSessionEnvVars } from './sessionEnvVars.js'

/**
 * Env vars to strip from subprocess environments when running inside GitHub
 * Actions. This prevents prompt-injection attacks from exfiltrating secrets
 * via shell expansion (e.g., ${ANTHROPIC_API_KEY}) in Bash tool commands.
 *
 * The parent claude process keeps these vars (needed for API calls, lazy
 * credential reads). Only child processes (bash, shell snapshot, MCP stdio, LSP, hooks) are scrubbed.
 *
 * GITHUB_TOKEN / GH_TOKEN are intentionally NOT scrubbed — wrapper scripts
 * (gh.sh) need them to call the GitHub API. That token is job-scoped and
 * expires when the workflow ends.
 */
const GHA_SUBPROCESS_SCRUB = [
  // Anthropic auth — claude re-reads these per-request, subprocesses don't need them
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',

  // OTLP exporter headers — documented to carry Authorization=Bearer tokens
  // for monitoring backends; read in-process by OTEL SDK, subprocesses never need them
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // Cloud provider creds — same pattern (lazy SDK reads)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC — consumed by the action's JS before claude spawns;
  // leaking these allows minting an App installation token → repo takeover
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — cache poisoning → supply-chain pivot
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // claude-code-action-specific duplicates — action JS consumes these during
  // prepare, before spawning claude. ALL_INPUTS contains anthropic_api_key as JSON.
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
] as const

/**
 * Returns a copy of process.env with sensitive secrets stripped, for use when
 * spawning subprocesses (Bash tool, shell snapshot, MCP stdio servers, LSP
 * servers, shell hooks).
 *
 * Gated on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB. claude-code-action sets this
 * automatically when `allowed_non_write_users` is configured — the flag that
 * exposes a workflow to untrusted content (prompt injection surface).
 */
// Registered by init.ts after the upstreamproxy module is dynamically imported
// in CCR sessions. Stays undefined in non-CCR startups so we never pull in the
// upstreamproxy module graph (upstreamproxy.ts + relay.ts) via a static import.
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * Called from init.ts to wire up the proxy env function after the upstreamproxy
 * module has been lazily loaded. Must be called before any subprocess is spawned.
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

/**
 * 把插件 runtime 目录前置进 PATH（**进程级**，供直接 spawn 的子进程继承）。
 *
 * 与 bash/powershell provider 的 `export PATH=...` 那条**不同路径**：
 * 那两个只影响 shell 命令串，不改本进程 env；而 MCP stdio server / LSP 等由
 * `StdioClientTransport` 直接 spawn，env 走 `subprocessEnv()` → 继承 `process.env`
 * → 拿不到 shell 命令串里的前置。
 *
 * 后果（2026-09-15 mac 实测）：`{"command":"npx"}` 的 MCP server（playwright-mcp）
 * spawn 失败（`env: npx: No such file or directory`），因为引擎 PATH 里只有
 * `.../nodejs/runtime` 根、没有 `runtime/bin`。而 AI Bash 里 `npx` 正常 ——
 * 那是 shell 命令串补的前置，容易误判为"已修好"。
 *
 * 存储格式：`CLAUDE_PLUGIN_PATH_PREPEND` 用 `;` 分隔**目录列表**（非 PATH 分隔符），
 * 这里用 `pathDelimiter` 拼（POSIX ':' / Windows ';'）。
 */
function withPluginRuntimePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prepend = getSessionEnvVars().get('CLAUDE_PLUGIN_PATH_PREPEND')
  if (!prepend) return env
  const dirs = prepend.split(';').filter(d => d.length > 0)
  if (dirs.length === 0) return env
  const cur = env.PATH ?? env.Path ?? ''
  // 幂等：所有目标目录都已在最前面就不重复叠加（同一进程多次调用很常见）。
  // 判据用**目录段前缀**而非 startsWith(dirs[0]) —— 后者会被前缀关系误命中
  // （`.../runtime` 是 `.../runtime/bin` 的前缀，导致每次都误判"已叠加"）。
  const head = dirs.join(pathDelimiter) + pathDelimiter
  if (cur.startsWith(head)) return env
  const merged = dirs.join(pathDelimiter) + (cur ? pathDelimiter + cur : '')
  return { ...env, PATH: merged, Path: merged }
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  // CCR upstreamproxy: inject HTTPS_PROXY + CA bundle vars so curl/gh/python
  // in agent subprocesses route through the local relay. Returns {} when the
  // proxy is disabled or not registered (non-CCR), so this is a no-op outside
  // CCR containers.
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}

  if (!isEnvTruthy(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)) {
    const base = Object.keys(proxyEnv).length > 0
      ? { ...process.env, ...proxyEnv }
      : { ...process.env }
    return withPluginRuntimePath(base)
  }
  const env = { ...process.env, ...proxyEnv }
  for (const k of GHA_SUBPROCESS_SCRUB) {
    delete env[k]
    // GitHub Actions auto-creates INPUT_<NAME> for `with:` inputs, duplicating
    // secrets like INPUT_ANTHROPIC_API_KEY. No-op for vars that aren't action inputs.
    delete env[`INPUT_${k}`]
  }
  return withPluginRuntimePath(env)
}
