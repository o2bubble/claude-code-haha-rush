#!/usr/bin/env bun
/**
 * memory-setup — Claude Code Memory MCP Server setup
 *
 * Usage:
 *   bun run scripts/memory-setup.ts
 *
 * Interactive: choose remote (Streamable HTTP URL) or local (Python + model).
 * Automatically:
 *   1. Add MCP server to ~/.claude/settings.json
 *   2. Install 3 slash-command skills to ~/.claude/skills/
 *   3. Copy agent instruction doc to ~/.claude/memory-mcp.md
 *   4. Add @memory-mcp.md reference to ~/.claude/CLAUDE.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const ROOT = dirname(import.meta.dirname ?? __dirname);
const MEMORY_DIR = join(ROOT, 'extensions', 'memory');
const CLAUDE_HOME = join(homedir(), '.claude');

function log(msg: string) { console.log(`[OK] ${msg}`); }
function info(msg: string) { console.log(`[*]  ${msg}`); }
function warn(msg: string) { console.log(`[!]  ${msg}`); }

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function run(cmd: string[], cwd?: string): boolean {
  const proc = Bun.spawnSync(cmd, { cwd, stdio: ['inherit', 'inherit', 'inherit'] });
  return proc.exitCode === 0;
}

// ── Step: MCP server config ─────────────────────────────────────────────────

function addToSettings(mcpConfig: Record<string, unknown>): void {
  const settingsFile = join(CLAUDE_HOME, 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf-8')); } catch {
      warn('settings.json is not valid JSON, creating new config.');
    }
  }

  const mcpServers = (settings.mcpServers as Record<string, unknown>) ?? {};
  mcpServers['memory'] = mcpConfig;
  settings.mcpServers = mcpServers;

  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  log('MCP config added to settings.json');
}

// ── Step: Install skills ────────────────────────────────────────────────────

function installSkills(): void {
  const skillsDir = join(CLAUDE_HOME, 'skills');
  const srcDir = join(MEMORY_DIR, 'skills');
  const skillFiles = ['remember.md', 'recall.md', 'memory-status.md'];

  for (const file of skillFiles) {
    const name = file.replace('.md', '');
    const targetDir = join(skillsDir, name);
    mkdirSync(targetDir, { recursive: true });
    cpSync(join(srcDir, file), join(targetDir, 'SKILL.md'));
  }
  log('3 skills installed to ~/.claude/skills/');
}

// ── Step: Agent instruction doc ─────────────────────────────────────────────

function installAgentDoc(): void {
  const src = join(ROOT, 'docs', 'agents', 'memory-mcp.md');
  const dst = join(CLAUDE_HOME, 'memory-mcp.md');

  if (!existsSync(src)) {
    warn(`Agent doc not found: ${src}`);
    return;
  }
  cpSync(src, dst);
  log('Agent doc copied to ~/.claude/memory-mcp.md');

  // Add @ reference to CLAUDE.md if not already present
  const claudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
  const refLine = '@memory-mcp.md';

  let content = '';
  if (existsSync(claudeMd)) {
    content = readFileSync(claudeMd, 'utf-8');
  }

  if (content.includes(refLine)) {
    log('CLAUDE.md already references memory-mcp.md');
    return;
  }

  // Append reference (add blank line first if needed)
  if (content.length > 0 && !content.endsWith('\n\n')) {
    content = content.replace(/\n*$/, '\n\n');
  }
  content += refLine + '\n';
  writeFileSync(claudeMd, content, 'utf-8');
  log('@memory-mcp.md reference added to ~/.claude/CLAUDE.md');
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function setupRemote(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log('');
  info('Remote mode — Streamable HTTP server (Docker on VPS/NAS).');
  info('No Python or model needed locally.');
  console.log('');

  const url = await question(rl, 'Server URL (e.g. http://192.168.1.100:8080/mcp): ');
  const cleanUrl = url.trim();
  if (!cleanUrl) { warn('No URL entered, aborting.'); return; }

  addToSettings({ type: 'http', url: cleanUrl });
}

async function setupLocal(): Promise<void> {
  console.log('');
  info('Local stdio mode — server runs on this machine.');
  console.log('');

  // Python
  info('Checking Python...');
  const pyCheck = Bun.spawnSync(['python', '--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (pyCheck.exitCode !== 0) {
    console.error('  ERROR: Python 3.10+ required. Install from https://python.org');
    process.exit(1);
  }
  const version = new TextDecoder().decode(pyCheck.stdout).trim();
  const match = version.match(/Python (\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1]), minor = parseInt(match[2]);
    if (major < 3 || (major === 3 && minor < 10)) {
      console.error(`  ERROR: Python 3.10+ required, got ${version}`);
      process.exit(1);
    }
  }
  log(`Found ${version}`);

  // pip install
  info('Installing Python dependencies...');
  const requirements = join(MEMORY_DIR, 'requirements.txt');
  if (run(['python', '-m', 'pip', 'install', '-r', requirements])) {
    log('Dependencies installed.');
  } else {
    warn(`pip install failed. Run: python -m pip install -r ${requirements}`);
  }

  // Model
  info('Downloading embedding model (all-MiniLM-L6-v2, ~80MB)...');
  if (run(['python', '-c',
    `from sentence_transformers import SentenceTransformer
SentenceTransformer('all-MiniLM-L6-v2')
print('Model ready.')`])) {
    log('Model ready.');
  } else {
    warn('Model download failed. Will download on first server startup.');
  }

  // MCP config
  const serverPath = join(MEMORY_DIR, 'server.py').replace(/\\/g, '/');
  const dbPath = join(homedir(), 'claude-memory.db').replace(/\\/g, '/');
  addToSettings({ command: 'python', args: [serverPath, '--db-path', dbPath] });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Claude Code Memory MCP Setup ===\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('Where is the memory MCP server?');
  console.log('  [1] Remote server (Docker on VPS/NAS)');
  console.log('  [2] Local machine (Python + model)');
  console.log('');

  const choice = (await question(rl, 'Choose [1/2] (default 1): ')).trim() || '1';

  if (choice === '2') {
    await setupLocal();
  } else {
    await setupRemote(rl);
  }

  // Shared steps (both modes)
  console.log('');
  installSkills();
  installAgentDoc();

  rl.close();

  console.log('');
  console.log('=== Setup complete ===');
  console.log('');
  console.log('Restart Claude Code, then try:');
  console.log('  /remember    — Smart memory deposition');
  console.log('  /recall      — Pre-task memory search');
  console.log('  /memory-status — System overview');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
