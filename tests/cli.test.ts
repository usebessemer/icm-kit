import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end check of the CLI: arg parsing, the workspace walk/write, the rule
 * run, the text report, and the exit codes, all the way through the CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const aiosRoot = join(here, 'fixtures', 'aios-mirror');
const privateRoot = join(here, 'fixtures', 'aios-private');

/** The seeded canaries the projection must strip from every output tree (SPEC §8). */
const CANARIES = [
  'Dana Winterbourne',
  'dana.winterbourne@example-private.test',
  'sk-canary-9f3a2b7c1e4d6f8a0b2c4e6f8a1b3d5f',
];

/** Read an output tree into its sorted relative paths and one concatenated blob. */
function readTree(dir: string): { paths: string[]; blob: string } {
  const paths: string[] = [];
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      paths.push(relative(dir, abs).split(sep).join('/'));
      parts.push(readFileSync(abs, 'utf8'));
    }
  };
  walk(dir);
  return { paths: paths.sort(), blob: parts.join('\n') };
}

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

describe('icm-kit sanitize (CLI, support mode)', () => {
  it('projects aios-private: exit 0, canary-free, secret omitted+flagged, output GREEN, deterministic', () => {
    const base = mkdtempSync(join(tmpdir(), 'icm-san-'));
    const base2 = mkdtempSync(join(tmpdir(), 'icm-san2-'));
    // A not-yet-existent child of a real tmp dir: sanitize writes a fresh tree.
    const out = join(base, 'out');
    const out2 = join(base2, 'out');
    try {
      const { status, stdout } = runCli(['sanitize', privateRoot, '--out', out]);
      expect(status).toBe(0);
      // The manifest accounts for every file and names its applied rule.
      expect(stdout).toContain('CLAUDE.md');
      expect(stdout).toContain('redact_instance');
      expect(stdout).toContain('secrets-shaped file present: secrets/credentials.txt');

      const tree = readTree(out);
      // The secrets file is absent from the output tree.
      expect(tree.paths).not.toContain('secrets/credentials.txt');
      expect(existsSync(join(out, 'secrets'))).toBe(false);
      // Zero occurrences of any seeded canary anywhere under --out.
      for (const canary of CANARIES) expect(tree.blob).not.toContain(canary);

      // The output tree audits GREEN.
      const audited = runCli(['audit', out]);
      expect(audited.status).toBe(0);
      expect(audited.stdout).toContain('No findings');

      // Determinism: a second run produces a byte-identical tree.
      expect(runCli(['sanitize', privateRoot, '--out', out2]).status).toBe(0);
      const tree2 = readTree(out2);
      expect(tree2.paths).toEqual(tree.paths);
      expect(tree2.blob).toBe(tree.blob);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(base2, { recursive: true, force: true });
    }
  }, 30000);

  it('fails closed on a workspace with unclassified files: exit 1, names them, writes nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'icm-san-fail-'));
    const out = join(base, 'out');
    try {
      const { status, stderr } = runCli(['sanitize', aiosRoot, '--out', out]);
      expect(status).toBe(1);
      expect(stderr).toContain('matched no projection rule');
      expect(stderr).toContain('clients/acme/brief.md');
      expect(existsSync(out)).toBe(false); // classify-all-first: nothing written
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  it('refuses a non-empty --out, an unknown --mode, and a missing --out', () => {
    const base = mkdtempSync(join(tmpdir(), 'icm-san-guard-'));
    try {
      // A populated --out is refused (fresh tree, never in-place).
      writeFileSync(join(base, 'occupied.txt'), 'not empty');
      const nonEmpty = runCli(['sanitize', privateRoot, '--out', base]);
      expect(nonEmpty.status).toBe(1);
      expect(nonEmpty.stderr).toContain('output directory is not empty');
      expect(nonEmpty.stderr).toContain('fresh tree');

      const badMode = runCli(['sanitize', privateRoot, '--out', join(base, 'x'), '--mode', 'extract']);
      expect(badMode.status).toBe(1);
      expect(badMode.stderr).toContain('extract');

      const noOut = runCli(['sanitize', privateRoot]);
      expect(noOut.status).toBe(1);
      expect(noOut.stderr).toContain('output directory is required');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 20000);
});
