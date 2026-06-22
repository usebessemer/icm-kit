import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end check of the `audit` command: arg parsing, the workspace walk, the
 * rule run, the text report, and the exit code, all the way through the CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const aiosRoot = join(here, 'fixtures', 'aios-mirror');

function runAudit(path: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(tsx, ['src/cli.ts', 'audit', path], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('icm-kit audit (CLI)', () => {
  it('reports findings and exits non-zero on a non-compliant workspace', () => {
    const { status, stdout } = runAudit(aiosRoot);
    expect(status).toBe(1);
    expect(stdout).toContain('LAYER_BLOAT');
    expect(stdout).toContain('HIDDEN_CONTEXT (enforces ROUTABLE_FILES)');
    expect(stdout).toContain('DUPLICATION');
    expect(stdout).toContain('14 finding(s).');
  }, 20000);
});
