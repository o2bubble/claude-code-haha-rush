/**
 * Shared edit-history.jsonl persistence for both IDE and CLI modes.
 *
 * Detects file edit tool results from assistant messages and appends
 * a unified-diff entry to ~/.claude/projects/{slug}/edit-history.jsonl.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';

// ═══════════════════════════════════════════════════════════════════════════
// Git helpers
// ═══════════════════════════════════════════════════════════════════════════

function getGitHeadHash(projectCwd: string): string | null {
  try {
    const headPath = join(projectCwd, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(projectCwd, '.git', head.slice(5));
      if (!existsSync(refPath)) return null;
      return readFileSync(refPath, 'utf-8').trim().slice(0, 40);
    }
    // Detached HEAD — the file content is the hash
    return head.slice(0, 40);
  } catch {
    return null;
  }
}

import { sanitizePath } from './sessionStoragePortable.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extracts file paths from tool_result blocks in an assistant message
 * and writes one unified-diff entry per edit to edit-history.jsonl.
 *
 * Supports both:
 *   - IDE mode: called from the WebSocket message handler
 *   - CLI mode: called after each tool result is processed
 */
export function persistEditHistory(
  messageContent: Array<Record<string, unknown>>,
  projectCwd: string,
  sessionId: string,
): void {
  const edits: Array<{ path: string; absPath: string }> = [];

  for (const block of messageContent) {
    if (block.type !== 'tool_result') continue;
    const text =
      (typeof block.content === 'string' ? block.content : '') ||
      (Array.isArray(block.content) &&
        (block.content as Array<{ text?: string }>)[0]?.text) ||
      '';

    let match = text.match(/^The file (.+?) has been updated/);
    if (!match) match = text.match(/^File created successfully at: (.+)$/);
    if (match) edits.push({ path: match[1], absPath: match[1] });
  }

  if (edits.length === 0) return;

  const gitCommit = getGitHeadHash(projectCwd);

  try {
    const configDir = join(homedir(), '.claude');
    const projectSlug = sanitizePath(projectCwd);
    const logDir = join(configDir, 'projects', projectSlug);
    const logFile = join(logDir, 'edit-history.jsonl');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    for (const edit of edits) {
      // Post-edit content = current file on disk
      let postEditContent = '';
      try {
        postEditContent = readFileSync(edit.absPath, 'utf-8');
      } catch {
        postEditContent = 'null';
      }

      // Pre-edit content from backup: ~/.claude/file-history/{sessionId}/{hash}@v{N}
      let preEditContent = 'null';
      try {
        const hash = createHash('sha256')
          .update(edit.absPath)
          .digest('hex')
          .slice(0, 16);
        const historyDir = join(configDir, 'file-history', sessionId);
        for (let v = 50; v >= 1; v--) {
          const bp = join(historyDir, `${hash}@v${v}`);
          if (existsSync(bp)) {
            preEditContent = readFileSync(bp, 'utf-8');
            break;
          }
        }
      } catch {
        /* no backup */
      }

      const oldContent = preEditContent === 'null' ? '' : preEditContent;
      const newContent = postEditContent === 'null' ? '' : postEditContent;

      const diff = createTwoFilesPatch(
        edit.absPath,
        edit.absPath,
        oldContent,
        newContent,
        'original',
        'modified',
      );

      const line =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          filePath: edit.absPath,
          label: `AI 编辑: ${edit.absPath.split(/[/\\]/).pop() || edit.absPath}`,
          gitCommit,
          diff,
        }) + '\n';

      appendFileSync(logFile, line, 'utf-8');
      console.error('[editHistory] appended %s', edit.absPath);
    }
  } catch (err) {
    console.error('[editHistory] write failed:', (err as Error).message);
  }
}

/**
 * Returns the edit-history system prompt text for the given project.
 */
export function getEditHistoryPrompt(projectCwd: string): string {
  const projectSlug = sanitizePath(projectCwd);
  const editHistoryPath = join(
    homedir(),
    '.claude',
    'projects',
    projectSlug,
    'edit-history.jsonl',
  );
  return (
    `## Edit History\n\n` +
    `Every file edit through the VS Code plugin is logged to \`${editHistoryPath}\`\n` +
    `in JSONL format (one JSON object per line, each with timestamp, filePath, label, unified diff, and gitCommit — the HEAD commit hash at the time of edit).\n\n` +
    `When the user asks you to review/rollback recent edits:\n` +
    `1. Read the last 20 lines of \`${editHistoryPath}\` with \`tail -n 20\`\n` +
    `2. Summarize the edits to the user\n` +
    `3. If rollback is requested, read the full entry, reverse the diff, and restore the file\n` +
    `4. If a git reset occurred, filter by gitCommit to find edits made on the old base\n`
  );
}
