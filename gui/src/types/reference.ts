/** Supported reference resource types — extensible */
export type ReferenceType = "file" | "dir" | "line" | "panel" | "session" | "paste" | "desktop" | "desktop-item" | "note";

/** A parsed external reference that identifies a resource */
export interface Reference {
  type: ReferenceType;
  /** File path, panel ID, session ID, etc. */
  path: string;
  /** Optional start line (1-indexed) */
  startLine?: number;
  /** Optional end line (inclusive) */
  endLine?: number;
  /** Optional display label (defaults to basename / id) */
  label?: string;
}

/** Parsed reference with position info for text replacement */
export interface ParsedReference extends Reference {
  /** The raw matched text (e.g. "@ref{file:/foo/bar.ts:42|label}") */
  raw: string;
  /** Start index in the original text */
  start: number;
  /** End index in the original text */
  end: number;
}
