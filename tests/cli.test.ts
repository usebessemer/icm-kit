import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end check of the CLI: arg parsing, the workspace walk/write, the rule
 * run, the text report, and the exit codes, all the way through the CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const aiosRoot = join(here, 'fixtures', 'aios-mirror');

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(tsx, ['src/cli.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function runAudit(path: string): { status: number; stdout: string } {
  return runCli(['audit', path]);
}

describe('icm-kit audit (CLI)', () => {
  it('reports findings and exits non-zero on a non-compliant workspace', () => {
    const { status, stdout } = runAudit(aiosRoot);
    expect(status).toBe(1);
    expect(stdout).toContain('LAYER_BLOAT');
    expect(stdout).toContain('HIDDEN_CONTEXT (enforces ROUTABLE_FILES)');
    expect(stdout).toContain('DUPLICATION');
    expect(stdout).toContain('SUPERSEDED_BUT_LIVE');
    expect(stdout).toContain('17 finding(s).');
  }, 20000);
});

describe('icm-kit init (CLI)', () => {
  it('scaffolds a fresh tree, exits 0, and initialises no git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-cli-init-'));
    try {
      const { status, stdout } = runCli(['init', dir]);
      expect(status).toBe(0);
      expect(stdout).toContain('Scaffolded');
      expect(readdirSync(dir)).toContain('CLAUDE.md');
      expect(existsSync(join(dir, '.git'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('refuses a non-empty target with a stderr message and exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-cli-guard-'));
    try {
      expect(runCli(['init', dir]).status).toBe(0);
      const { status, stderr } = runCli(['init', dir]);
      expect(status).toBe(1);
      expect(stderr).toContain('not an empty directory');
      expect(runCli(['init', dir, '--overwrite']).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('scaffolds a role workspace with --role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-cli-role-'));
    try {
      const { status } = runCli(['init', dir, '--role', 'example']);
      expect(status).toBe(0);
      expect(existsSync(join(dir, 'workspaces', 'example', 'CLAUDE.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
