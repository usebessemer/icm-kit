import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGitInfo } from '../src/git.js';

/**
 * `readGitInfo` is the provenance seam behind KIT_BOILERPLATE (§4.7). These run
 * against icm-kit's own repository: `SPEC.md` is the one file present at the root
 * commit (the default fork point), so it is the fixture for "existed at fork".
 * The audit-level F7 behaviour is pinned separately with injected synthetic git
 * (audit.test.ts), since the committed fixtures cannot fake a real fork point.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

describe('readGitInfo() against the icm-kit repository', () => {
  const info = readGitInfo(repoRoot);

  it('marks a file that existed at the root commit and was touched since', () => {
    const spec = info.get('SPEC.md');
    expect(spec?.tracked).toBe(true);
    expect(spec?.existedAtForkPoint).toBe(true);
    // SPEC.md has evolved across every version bump, so it is not boilerplate.
    expect(spec?.postForkCommits ?? 0).toBeGreaterThan(0);
  });

  it('marks a tracked file added after the root commit as not present at the fork', () => {
    const model = info.get('src/model.ts');
    expect(model?.tracked).toBe(true);
    expect(model?.existedAtForkPoint).toBe(false);
  });

  it('shifts the boundary with an explicit fork point: nothing is after HEAD', () => {
    const atHead = readGitInfo(repoRoot, 'HEAD');
    const spec = atHead.get('SPEC.md');
    // With the fork point at HEAD, every present file has zero commits since,
    // so SPEC.md now reads as inherited-and-untouched (the F7 fire shape).
    expect(spec?.existedAtForkPoint).toBe(true);
    expect(spec?.postForkCommits).toBe(0);
  });

  it('degrades to silence on an unresolvable fork point (under-report, not error)', () => {
    expect(readGitInfo(repoRoot, 'no-such-ref-xyz').size).toBe(0);
  });
});

describe('readGitInfo() off any git repository', () => {
  it('returns an empty map (every file reads as untracked)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-git-'));
    try {
      expect(readGitInfo(dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
