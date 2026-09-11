// Stub: Context collapse service — loaded on-demand by TokenWarning component.
export function getStats() {
  return {
    collapsedSpans: 0,
    stagedSpans: 0,
    health: { totalErrors: 0, totalEmptySpawns: 0, emptySpawnWarningEmitted: false },
  }
}
export function subscribe(cb) {
  return () => {}
}
