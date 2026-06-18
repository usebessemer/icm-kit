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
 * Build an in-memory Workspace from a `path -> content` map, for rule tests
 * that need a precise tree without committing fixture directories. Mirrors the
 * shape `readWorkspace` produces.
 */
export function buildWorkspace(contents: Record<string, string>): Workspace {
  const files: WorkspaceFile[] = Object.keys(contents)
    .sort()
    .map((path) => ({
      path,
      content: contents[path],
      bytes: Buffer.byteLength(contents[path], 'utf8'),
      isText: true,
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
