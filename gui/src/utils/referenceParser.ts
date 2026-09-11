import type { Reference, ParsedReference, ReferenceType } from "../types/reference";

const REF_REGEX = /@ref\{([^}]+)\}/g;

const KNOWN_TYPES = new Set<string>(["file", "dir", "line", "panel", "session", "paste", "desktop", "desktop-item", "note"]);

/** Minimal encoding — only escape characters that break @ref{...} format: : | } */
function encodePastePath(path: string): string {
  return path.replace(/[}:|]/g, (ch) => {
    if (ch === ":") return "%3A";
    if (ch === "|") return "%7C";
    return "%7D"; // }
  });
}

function decodePastePath(encoded: string): string {
  return encoded.replace(/%3A/gi, ":").replace(/%7C/gi, "|").replace(/%7D/gi, "}");
}

/**
 * Parse all @ref{...} references in text.
 * Returns array of ParsedReference with position info for replacement.
 */
export function parseReferences(text: string): ParsedReference[] {
  const results: ParsedReference[] = [];
  let match: RegExpExecArray | null;

  while ((match = REF_REGEX.exec(text)) !== null) {
    const raw = match[0];
    const inner = match[1];
    const start = match.index;

    try {
      // Split: first find label (last |), then parse type:path:range
      let labelPart: string | undefined;
      let content = inner;

      const lastPipe = inner.lastIndexOf("|");
      if (lastPipe >= 0) {
        labelPart = inner.slice(lastPipe + 1);
        content = inner.slice(0, lastPipe);
      }

      // Parse content: type:path[:range]
      const colon1 = content.indexOf(":");
      if (colon1 < 0) continue; // missing type separator

      const type = content.slice(0, colon1) as ReferenceType;
      if (!KNOWN_TYPES.has(type)) continue; // unknown type, skip

      const rest = content.slice(colon1 + 1);
      let path: string;
      let startLine: number | undefined;
      let endLine: number | undefined;

      // Check for line range: last colon followed by digits or digit-digit (skip for paste)
      if (type !== "paste") {
        const rangeMatch = rest.match(/^(.+):(\d+)(?:-(\d+))?$/);
        if (rangeMatch) {
          path = rangeMatch[1];
          startLine = parseInt(rangeMatch[2], 10);
          endLine = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : undefined;
        } else {
          path = rest;
        }
      } else {
        path = rest;
      }

      if (!path) continue;

      // Decode minimal-encoded path for paste type, then try full URI decode
      if (type === "paste") {
        path = decodePastePath(path);
        try {
          const decoded = decodeURIComponent(path);
          if (decoded !== path) path = decoded;
        } catch { /* not URI-encoded */ }
      }

      results.push({
        type,
        path,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(labelPart ? { label: labelPart } : {}),
        raw,
        start,
        end: start + raw.length,
      });
    } catch {
      // Malformed — skip
    }
  }

  return results;
}

/**
 * Serialize a Reference back to @ref{...} format.
 */
export function formatReference(ref: Reference): string {
  let pathPart = ref.path;
  if (ref.type === "paste") {
    pathPart = encodePastePath(ref.path);
  }

  let inner = `${ref.type}:${pathPart}`;

  if (ref.startLine !== undefined) {
    inner += `:${ref.startLine}`;
    if (ref.endLine !== undefined && ref.endLine !== ref.startLine) {
      inner += `-${ref.endLine}`;
    }
  }

  if (ref.label) {
    inner += `|${ref.label}`;
  }

  return `@ref{${inner}}`;
}
