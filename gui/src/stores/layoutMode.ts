// Global layout mode — when active, all hover-triggered controls stay visible permanently.
// Synced across windows via DataBus.

type Listener = () => void;
let _enabled = false;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
  // Publish to DataBus for cross-window sync (dynamic import to avoid circular deps)
  import("../services/crossWindowBus").then(({ crossWindowBus }) => {
    crossWindowBus.publish("layout.mode", _enabled, { sticky: true });
  }).catch(() => {});
}

export const layoutMode = {
  get enabled() { return _enabled; },
  toggle() {
    _enabled = !_enabled;
    notify();
  },
  set(v: boolean) {
    if (_enabled === v) return;
    _enabled = v;
    notify();
  },
  /** Called by DataBus Leaf adapter to sync mode from Hub. */
  syncFromBus(v: boolean) {
    if (_enabled === v) return;
    _enabled = v;
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
