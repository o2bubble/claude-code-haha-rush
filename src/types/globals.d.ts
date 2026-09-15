/**
 * Runtime globals injected before any module loads.
 *
 * `preload.ts` (repo root) does `Object.assign(globalThis, { MACRO: {...} })`
 * before the rest of the tree is imported, so `MACRO` is available everywhere
 * as a bare identifier.
 *
 * The original build substituted `MACRO` at bundle time via a bundler define,
 * which is why the source uses it freely while no module ever declares or
 * imports it. tsc has no way to know that — without this file every
 * `MACRO.VERSION` is a "Cannot find name 'MACRO'" error (145 of them).
 *
 * Keep this shape in sync with preload.ts. Values are all strings; they are
 * only ever interpolated into messages, never compared against literals, so
 * they are typed as plain `string` (narrowing them to literals would produce
 * "comparison appears unintentional" errors at any future comparison site).
 */
declare var MACRO: {
  /** e.g. "2.1.89 (sync:2.1.211)" */
  VERSION: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  /** ISO timestamp of the build */
  BUILD_TIME: string
  /** Where users should post feedback, e.g. "the issue tracker" */
  FEEDBACK_CHANNEL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
}
