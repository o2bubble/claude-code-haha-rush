// Slash command routing — maps command names to A/B/C/D categories

export type RouteCategory = "A" | "B" | "C" | "D";

export interface RouteDecision {
  category: RouteCategory;
  action: "ws_text" | "panel" | "terminal" | "blocked";
  panelId?: string;
  terminalType?: string;
}

// B: GUI panel mapping
const PANEL_MAP: Record<string, string> = {
  plan: "plan",
  tasks: "tasks",
  diff: "editor",
  model: "model",
  desktop: "super-desktop",
};

// C: Terminal fallback
const TERMINAL_COMMANDS = new Set([
  "plugins", "plugin", "marketplace",
  "config",
  "memory",
  "doctor",
  "hooks",
  "sandbox",
  "btw",
  "session", "remote",
  "mobile", "ios", "android",
  "passes",
  "feedback", "bug",
  "privacy-settings",
  "ultrareview",
  "think-back",
  "remote-env",
  "rate-limit-options",
  "terminal-setup",
  "thinkback-play",
]);

// D: Permanently blocked in GUI
const BLOCKED_COMMANDS = new Set([
  "exit", "quit",
  "login",
  "logout",
  "upgrade",
  "chrome",
  "desktop", "app",
  "output-style",
  "install-github-app",
  "install",
  "stickers",
  "add-dir",
]);

export function routeCommand(cmdName: string, _cmdType?: string): RouteDecision {
  const name = cmdName.toLowerCase();

  // B: panel mapping (highest priority)
  if (PANEL_MAP[name]) {
    return { category: "B", action: "panel", panelId: PANEL_MAP[name] };
  }

  // C: terminal fallback
  if (TERMINAL_COMMANDS.has(name)) {
    return { category: "C", action: "terminal" };
  }

  // D: blocked
  if (BLOCKED_COMMANDS.has(name)) {
    return { category: "D", action: "blocked" };
  }

  // A: send as text to backend (default)
  return { category: "A", action: "ws_text" };
}
