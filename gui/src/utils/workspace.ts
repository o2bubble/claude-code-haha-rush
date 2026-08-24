// Workspace path helpers — used to show the bound workspace in the window title
// and toolbar (each GUI instance binds one workspace).

export function workspaceBasename(path: string): string {
  if (!path) return "";
  // Strip trailing separators so "C:\foo\" resolves to "foo", not "".
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  const segs = trimmed.split(/[\\/]+/).filter(Boolean);
  return segs[segs.length - 1] || trimmed;
}
