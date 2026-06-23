/**
 * Test-only helper: read a committed synthetic workspace fixture into the
 * shape `classify()` consumes: a flat, POSIX-relative file tree plus the text
 * of every `CLAUDE.md` in it.
 *
 * This is deliberately minimal. The production workspace walker (ignore rules,
 * binary handling, nested-workspace boundaries as audit units) is the audit
 * runner's concern (issue #4), not the classifier's.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace, WorkspaceFile } from '../../src/workspace.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Synthetic git provenance for `buildWorkspace`, keyed by path. Each entry sets
 * the KIT_BOILERPLATE (§4.7) facts a real `readGitInfo` would resolve; omitted
 * fields and omitted paths default to off-repo (`tracked: false`), so a fixture
 * never fires F7 unless it opts in. This is the test seam: the committed
 * fixtures live in icm-kit's own git history, so a real fork point cannot be
 * faked there, and F7's git signal is injected here instead.
 */
export type SyntheticGit = Record<
  string,
  Partial<Pick<WorkspaceFile, 'tracked' | 'postForkCommits' | 'existedAtForkPoint'>>
>;

/**
 * Build an in-memory Workspace from a `path -> content` map, for rule tests
 * that need a precise tree without committing fixture directories. Mirrors the
 * shape `readWorkspace` produces. The optional `git` map injects per-path
 * provenance for KIT_BOILERPLATE (§4.7); paths default to off-repo.
 */
export function buildWorkspace(
  contents: Record<string, string>,
  git: SyntheticGit = {},
): Workspace {
  const files: WorkspaceFile[] = Object.keys(contents)
    .sort()
    .map((path) => ({
      path,
      content: contents[path],
      bytes: Buffer.byteLength(contents[path], 'utf8'),
      isText: true,
      tracked: git[path]?.tracked ?? false,
      postForkCommits: git[path]?.postForkCommits ?? null,
      existedAtForkPoint: git[path]?.existedAtForkPoint ?? false,
    }));
  const tree = files.map((f) => f.path);
  const claudeMd = new Map<string, string>();
  for (const file of files) {
    if (file.path === 'CLAUDE.md' || file.path.endsWith('/CLAUDE.md')) {
      claudeMd.set(file.path, file.content);
    }
  }
  return { root: '/virtual', files, tree, claudeMd };
}

/** Inputs to `classify()`, mirroring the SPEC §2.5 signature. */
export interface WorkspaceFixture {
  /** Every file path in the workspace, relative to its root, POSIX-separated. */
  readonly tree: readonly string[];
  /** `CLAUDE.md` contents keyed by their tree path (the lineage). */
  readonly claudeMd: ReadonlyMap<string, string>;
}

/** Read the fixture workspace named `name` under `tests/fixtures/`. */
export function readFixture(name: string): WorkspaceFixture {
  const root = join(here, '..', 'fixtures', name);
  const tree: string[] = [];
  const claudeMd = new Map<string, string>();
  walk(root, root, tree, claudeMd);
  tree.sort();
  return { tree, claudeMd };
}

function walk(
  root: string,
  dir: string,
  tree: string[],
  claudeMd: Map<string, string>,
): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(root, abs, tree, claudeMd);
      continue;
    }
    const rel = relative(root, abs).split(sep).join('/');
    tree.push(rel);
    if (entry === 'CLAUDE.md') {
      claudeMd.set(rel, readFileSync(abs, 'utf8'));
    }
  }
}
