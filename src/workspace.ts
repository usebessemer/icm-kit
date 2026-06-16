/**
 * Workspace reader: walk a directory into the structure the audit runner and
 * the classifier consume.
 *
 * A workspace is the directory rooted at a `CLAUDE.md` (SPEC §2.1). The reader
 * collects every file as a POSIX-relative path, its UTF-8 text and byte size,
 * and the text of every `CLAUDE.md` (the lineage the classifier parses).
 *
 * The ignore list is hard-coded for v0.1 (configurable ignore lists are
 * deferred, SPEC §5). Unreadable or non-UTF-8 files are kept in the tree with
 * empty text so routing rules still see them; only their content-based signals
 * (token size, content-type sniffing) go quiet.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT_IDENTITY_FILE } from './model.js';

/** Directory and file names skipped while walking (v0.1 hard-coded, SPEC §5). */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.DS_Store',
]);

/** One file in a workspace. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, POSIX-separated. */
  readonly path: string;
  /** UTF-8 text, or '' when the file is unreadable or not UTF-8. */
  readonly content: string;
  /** Size on disk in bytes. */
  readonly bytes: number;
}

/** A workspace read from disk, ready to classify and audit. */
export interface Workspace {
  /** Absolute filesystem path of the audit root. */
  readonly root: string;
  /** Every file, sorted by path. */
  readonly files: readonly WorkspaceFile[];
  /** Every file path, sorted (a convenience view of `files`). */
  readonly tree: readonly string[];
  /** `CLAUDE.md` text keyed by tree path (the lineage). */
  readonly claudeMd: ReadonlyMap<string, string>;
}

/** Read the workspace rooted at the directory `root`. */
export function readWorkspace(root: string): Workspace {
  const files: WorkspaceFile[] = [];
  walk(root, root, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tree = files.map((f) => f.path);
  const claudeMd = new Map<string, string>();
  for (const file of files) {
    if (baseName(file.path) === ROOT_IDENTITY_FILE) {
      claudeMd.set(file.path, file.content);
    }
  }

  return { root, files, tree, claudeMd };
}

function walk(root: string, dir: string, out: WorkspaceFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_NAMES.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(root, abs, out);
      continue;
    }
    const path = relative(root, abs).split(sep).join('/');
    out.push({ path, content: readText(abs), bytes: statSync(abs).size });
  }
}

function readText(abs: string): string {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
