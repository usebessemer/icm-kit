/**
 * Workspace reader: walk a directory into the structure the audit runner and
 * the classifier consume.
 *
 * A workspace is the directory rooted at a `CLAUDE.md` (SPEC §2.1). The reader
 * collects every file as a POSIX-relative path, its UTF-8 text, byte size, and
 * a text/binary flag (the text of every `CLAUDE.md` is the lineage the
 * classifier parses).
 *
 * The ignore list is name-based and configurable: the hard-coded defaults
 * (`.git`, `node_modules`, `archives`, etc.) merge with an optional `ignore`
 * set threaded from the CLI. Ignored names are skipped at any depth; a
 * configurable file format for the ignore list is deferred (SPEC §5).
 *
 * Binary detection is a NUL-byte head sniff, not an extension allowlist:
 * `readFileSync(abs, 'utf8')` does not throw on binary input (it returns a
 * lossy string), so the sniff is what lets the rules exclude binaries from
 * token-counting (§4.1). An unknown text extension is never dropped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT_IDENTITY_FILE } from './model.js';

/** Directory and file names skipped while walking (name-based, any depth). */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.DS_Store',
  'archives',
]);

/** Bytes from the head of a file sniffed for the NUL binary signal. */
const SNIFF_BYTES = 8192;

/** One file in a workspace. */
export interface WorkspaceFile {
  /** Path relative to the workspace root, POSIX-separated. */
  readonly path: string;
  /** UTF-8 text, or '' when the file is binary or unreadable. */
  readonly content: string;
  /** Size on disk in bytes. */
  readonly bytes: number;
  /** True when the file is UTF-8 text (no NUL byte in its head). */
  readonly isText: boolean;
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

/** Options for reading a workspace. */
export interface ReadWorkspaceOptions {
  /** Extra names to skip, merged with `IGNORED_NAMES`. */
  readonly ignore?: Iterable<string>;
}

/** Read the workspace rooted at the directory `root`. */
export function readWorkspace(
  root: string,
  options: ReadWorkspaceOptions = {},
): Workspace {
  const ignore = new Set(IGNORED_NAMES);
  for (const name of options.ignore ?? []) ignore.add(name);

  const files: WorkspaceFile[] = [];
  walk(root, root, files, ignore);
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

function walk(
  root: string,
  dir: string,
  out: WorkspaceFile[],
  ignore: ReadonlySet<string>,
): void {
  for (const entry of readdirSync(dir)) {
    if (ignore.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(root, abs, out, ignore);
      continue;
    }
    const path = relative(root, abs).split(sep).join('/');
    out.push(readFile(abs, path));
  }
}

function readFile(abs: string, path: string): WorkspaceFile {
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    return { path, content: '', bytes: safeSize(abs), isText: false };
  }
  const isText = !hasNulByte(buffer);
  return {
    path,
    content: isText ? buffer.toString('utf8') : '',
    bytes: buffer.length,
    isText,
  };
}

/** True if a NUL byte appears in the head of the buffer (the binary signal). */
function hasNulByte(buffer: Buffer): boolean {
  const head = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < head; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function safeSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
