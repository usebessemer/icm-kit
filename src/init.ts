/**
 * Workspace generator: write the canonical ICM template tree to a target
 * directory. The inverse of the reader in `workspace.ts` (SPEC §7): where the
 * reader walks a directory into the structure the audit runner consumes, the
 * generator writes the exact byte tree that, read back and audited, returns
 * zero findings (the §7.1 audit-green invariant).
 *
 * The template bytes are authored under `src/templates/` (SPEC §7.2). This
 * module resolves that tree into an ordered `GeneratedFile[]`, applies the
 * `--role` expansion (§7.6) when a role is named, guards a non-empty target,
 * and writes through one injectable seam so every step but the final disk write
 * is pure and testable with a capturing writer.
 *
 * Line endings are normalised to LF on read of the templates, matching the
 * reader's CRLF->LF normalisation, so a round-trip is byte-stable regardless of
 * how the templates were checked out (SPEC §7.1). Reads (template resolution,
 * the target-emptiness probe) go through `node:fs` directly; the only writes go
 * through `FileWriter`.
 *
 * No git initialisation happens here: the emitted tree is plain, so every file
 * reads as off-repo (`tracked: false`) and F7 (KIT_BOILERPLATE) stays silent on
 * a genuinely fresh install (SPEC §7.8).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_IDENTITY_FILE } from './model.js';

/** One file to write: a POSIX-relative path within the target and its bytes. */
export interface GeneratedFile {
  /** Path relative to the target root, POSIX-separated. */
  readonly path: string;
  /** UTF-8 text, LF newlines. */
  readonly content: string;
}

/**
 * The one disk-write seam. Given the target root and the assembled files, write
 * each one (creating parent directories). Injectable so the assembly and guard
 * are exercisable without touching disk via a capturing writer.
 */
export type FileWriter = (target: string, files: readonly GeneratedFile[]) => void;

/** Options for generating a workspace. */
export interface WriteWorkspaceOptions {
  /** Write into a non-empty target instead of refusing it. */
  readonly overwrite?: boolean;
  /** Also emit a minimal L1 role workspace under `workspaces/<role>/` (§7.6). */
  readonly role?: string;
  /** The disk-write seam; defaults to the real UTF-8 LF writer. */
  readonly writer?: FileWriter;
}

/**
 * Thrown when the target directory exists and is not empty and `overwrite` is
 * not set: the guard refuses to clobber it and nothing is written (SPEC §7,
 * `init` non-empty-target guard). The CLI catches this to print a clear stderr
 * message and set a non-zero exit code rather than surface a stack trace.
 */
export class NonEmptyTargetError extends Error {
  constructor(public readonly target: string) {
    super(
      `target is not an empty directory: ${target} (pass --overwrite to write into it anyway)`,
    );
    this.name = 'NonEmptyTargetError';
  }
}

/** Thrown when `--role` is not a single safe path segment. */
export class InvalidRoleError extends Error {
  constructor(public readonly role: string) {
    super(`invalid role name: ${JSON.stringify(role)} (use letters, digits, '.', '-', '_')`);
    this.name = 'InvalidRoleError';
  }
}

/** The authored template tree, resolved relative to this module (SPEC §7.2). */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/** The role-less default holds only `.gitkeep` in `workspaces/` (SPEC §7.6). */
const WORKSPACES_GITKEEP = 'workspaces/.gitkeep';

/** OS-noise names never emitted, matching the reader's ignore list. */
const TEMPLATE_IGNORED_NAMES: ReadonlySet<string> = new Set(['.DS_Store']);

/** A role name must be one safe path segment: no separators, no `.`/`..`. */
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Generate the canonical workspace at `target` and return the files written.
 *
 * Resolves the §7.2 template tree, applies the `--role` expansion when a role
 * is named, guards a non-empty target, then writes through the (default or
 * injected) `FileWriter`. On the non-empty-target refusal nothing is written
 * and `NonEmptyTargetError` is thrown.
 */
export function writeWorkspace(
  target: string,
  options: WriteWorkspaceOptions = {},
): GeneratedFile[] {
  const files = assembleFiles(options.role);
  guardTarget(target, options.overwrite ?? false);
  const writer = options.writer ?? defaultWriter;
  writer(target, files);
  return files;
}

/**
 * Resolve the template tree into the ordered file set to write, applying the
 * role expansion. Pure given the templates on disk: no target is touched, so a
 * capturing writer can exercise the whole assembly without a disk write.
 */
export function assembleFiles(role?: string): GeneratedFile[] {
  const base = readTemplates();
  if (role === undefined) return sortByPath(base);

  if (!ROLE_NAME.test(role) || role === '.' || role === '..') {
    throw new InvalidRoleError(role);
  }
  // A role fills `workspaces/`, so the empty-dir marker is no longer needed.
  const withoutMarker = base.filter((f) => f.path !== WORKSPACES_GITKEEP);
  return sortByPath([...withoutMarker, ...roleFiles(role)]);
}

/**
 * The minimal L1 role workspace (SPEC §7.6): a `CLAUDE.md` charter and a
 * `context/` home held by `.gitkeep`, and nothing else. No pre-built
 * `references/` or `.claude/skills/` levels. The charter is thin, original
 * prose (so F8 does not flag it against the root) with short sections (so F5
 * variant B stays clear), and follows the root's `begin` fall-through (§7.3).
 */
function roleFiles(role: string): GeneratedFile[] {
  const dir = `workspaces/${role}`;
  return [
    { path: `${dir}/${ROOT_IDENTITY_FILE}`, content: roleCharter(role) },
    { path: `${dir}/context/.gitkeep`, content: '' },
  ];
}

function roleCharter(role: string): string {
  return `# The ${role} role

This is an L1 role workspace stacked on the root install. It inherits the operator's root identity and adds this stream's charter; it does not restate what the root already holds. Everything here is scoped to this role's own work.

## What this role is

\`${role}\` is a starter stream generated by \`icm-kit init --role ${role}\`. Rename the folder, or replace this charter with the real stream's identity, when you adopt the workspace. A role owns one stream of work and runs one altitude below the root.

## Session start (begin)

On session start, read \`handoff.md\` if it is present and continue from where it leaves off. If there is no handoff, fall through cleanly to the standing structure: orient from the root board, then pick up this role's active work.

## Context (situational, in context/)

This role's situational memory lives in [\`context/\`](context/): who the work is for, its current state, and the preferences that shape it. The home starts empty and fills as the role does real work. Durable operator knowledge stays at the root; only what is specific to this stream belongs here.

## How you work

You surface options and draft; the operator decides. Keep this charter thin: route detail into \`context/\` rather than inlining it here, so the role's identity stays legible.
`;
}

/**
 * Refuse a non-empty target unless `overwrite` is set. A non-existent or empty
 * directory writes freely; anything that is not an empty directory (a populated
 * directory or a file at the path) is refused. This is a read of the target
 * only; it never writes, so the assembly path stays disk-free with a capturing
 * writer against a non-existent target.
 */
function guardTarget(target: string, overwrite: boolean): void {
  if (overwrite) return;
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return; // does not exist: free to write (parents are created on write)
  }
  if (!stat.isDirectory() || readdirSync(target).length > 0) {
    throw new NonEmptyTargetError(target);
  }
}

/** The default seam: create each parent directory and write UTF-8 LF bytes. */
const defaultWriter: FileWriter = (target, files) => {
  for (const file of files) {
    const abs = join(target, ...file.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, 'utf8');
  }
};

/** Walk `src/templates/` into a file set, LF-normalised, sorted by path. */
function readTemplates(): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  walkTemplates(TEMPLATES_DIR, TEMPLATES_DIR, out);
  return sortByPath(out);
}

function walkTemplates(root: string, dir: string, out: GeneratedFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (TEMPLATE_IGNORED_NAMES.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walkTemplates(root, abs, out);
      continue;
    }
    const path = relative(root, abs).split(sep).join('/');
    // Normalise CRLF to LF so the emitted tree is byte-stable regardless of how
    // the templates were checked out (matches the reader; SPEC §7.1).
    out.push({ path, content: readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') });
  }
}

function sortByPath(files: GeneratedFile[]): GeneratedFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
