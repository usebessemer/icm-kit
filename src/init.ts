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
  /**
   * Instead emit a minimal L1 delegating-lead class workspace under
   * `workspaces/<class>/` (§7.9). Mutually exclusive with `role`.
   */
  readonly class?: string;
  /** The disk-write seam; defaults to the real UTF-8 LF writer. */
  readonly writer?: FileWriter;
}

/**
 * The role/class selection for {@link assembleFiles}: at most one of `role` /
 * `class` may be set. A class is a specialised role (SPEC §7.9), so stacking the
 * two is meaningless and refused.
 */
export interface AssembleOptions {
  /** Emit a minimal L1 role workspace (§7.6). */
  readonly role?: string;
  /** Emit a minimal L1 delegating-lead class workspace (§7.9). */
  readonly class?: string;
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

/**
 * Thrown when `--class` names a class the binder does not know. v1 ships exactly
 * one class value, `devlead` (SPEC §7.9); any other value is a user error, not a
 * silent no-op. The CLI catches this to print a clean stderr line.
 */
export class UnknownClassError extends Error {
  constructor(public readonly className: string) {
    super(`unknown class: ${JSON.stringify(className)} (the only class in v1 is "devlead")`);
    this.name = 'UnknownClassError';
  }
}

/**
 * Thrown when both `--role` and `--class` are given. A class is a specialised
 * role, so the two are mutually exclusive (SPEC §7.9); passing both is a usage
 * error refused before anything is written. The CLI catches this to print a
 * clean stderr line and set a non-zero exit code.
 */
export class RoleClassConflictError extends Error {
  constructor() {
    super('cannot combine --role and --class: a class is a specialised role, so pass at most one');
    this.name = 'RoleClassConflictError';
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
 * The class values `--class` accepts. v1 ships exactly one, `devlead` (SPEC
 * §7.9); a domain axis (a registry of class values) stays deferred until a
 * second built lead-domain forces it.
 */
const KNOWN_CLASSES: ReadonlySet<string> = new Set(['devlead']);

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
  const files = assembleFiles({ role: options.role, class: options.class });
  guardTarget(target, options.overwrite ?? false);
  const writer = options.writer ?? defaultWriter;
  writer(target, files);
  return files;
}

/**
 * Resolve the template tree into the ordered file set to write, applying the
 * `--role` (§7.6) or `--class` (§7.9) expansion. Pure given the templates on
 * disk: no target is touched, so a capturing writer can exercise the whole
 * assembly without a disk write.
 *
 * At most one of `role` / `class` may be given; both together throws
 * `RoleClassConflictError` (SPEC §7.9). The guard lives here rather than at the
 * CLI so every caller of the assembler gets it, and it runs before any file is
 * written so a rejected combination scaffolds nothing.
 */
export function assembleFiles(options: AssembleOptions = {}): GeneratedFile[] {
  const { role, class: className } = options;
  if (role !== undefined && className !== undefined) {
    throw new RoleClassConflictError();
  }

  const base = readTemplates();
  if (role === undefined && className === undefined) return sortByPath(base);

  // A role or a class fills `workspaces/`, so the empty-dir marker is dropped.
  const withoutMarker = base.filter((f) => f.path !== WORKSPACES_GITKEEP);

  if (className !== undefined) {
    if (!KNOWN_CLASSES.has(className)) throw new UnknownClassError(className);
    return sortByPath([...withoutMarker, ...classFiles(className)]);
  }

  if (!ROLE_NAME.test(role!) || role === '.' || role === '..') {
    throw new InvalidRoleError(role!);
  }
  return sortByPath([...withoutMarker, ...roleFiles(role!)]);
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
 * The minimal L1 delegating-lead class workspace (SPEC §7.9): a `CLAUDE.md`
 * charter carrying all directive prose and a `context/leaf.md` situational
 * pointer, and nothing else. No pre-built `references/` or `.claude/skills/`
 * levels; routing depth stays at 2. The charter is original paraphrase of the
 * delegating-lead contract (so F8 stays clear against the shipped
 * `references/agent-roles.md`) and compact (so F5 variant B and the 4000-token
 * `CLAUDE.md` cap stay clear); `leaf.md` is situational-only (no behaviour
 * block, so W3 stays silent). The generator adds files only under
 * `workspaces/<class>/` and never mutates a shipped file: the charter instead
 * documents adding the `registry.md` row as a one-line operator action.
 */
function classFiles(className: string): GeneratedFile[] {
  const dir = `workspaces/${className}`;
  return [
    { path: `${dir}/${ROOT_IDENTITY_FILE}`, content: classCharter(className) },
    { path: `${dir}/context/leaf.md`, content: classLeaf() },
  ];
}

function classCharter(className: string): string {
  return `# The delegating-lead class (${className})

This is an L1 delegating-lead workspace stamped below the root by \`icm-kit init --class ${className}\`. Its identity is a \`(Lead, Standing)\` cell: a lead role (it routes work rather than executing it) that stands (it persists across sessions instead of spinning up per task). Stacked on the operator's root identity, it runs a board, hands the hands-on building to a dev leaf, and carries decisions back up to the operator without authoring the work itself. Rename the folder and fill in this stream's real domain when you adopt it; what ships here is the reusable class contract, not one stream's specifics.

## What a delegating lead does

The class earns its keep by routing work, not by typing it. Three clauses fix the contract:

- **Surface, do not decide.** Anything past the leaf's given acceptance criteria (a scope question, a spec gap, a trade-off with product weight) goes up to the operator as a flagged choice; it is never settled here on the lead's own authority.
- **Delegate, do not author.** The building belongs to the leaf. This altitude scopes the unit of work, writes its acceptance criteria, and reviews what comes back; it does not open the editor and produce the deliverable in the leaf's place.
- **Bubble up.** Finished work and the decisions that shaped it travel back to the operator on the shared artifacts (the board, the channels), so the state of the stream reads straight from the files.

## The dev leaf

This lead spawns one dev leaf that does the scoped building. Who that leaf is, the repo it works in, and how work reaches it are situational, so they live in [\`context/leaf.md\`](context/leaf.md) rather than in this charter, keeping the contract legible.

## Bindings

A compact table binds the reusable class to this concrete code stream. Fill each row in on adoption; keep it to one line apiece so the contract stays legible.

| Binding | This stream |
|---|---|
| Dev leaf (repo / scope) | _(see [\`context/leaf.md\`](context/leaf.md); set on adoption)_ |
| Board (where work is queued) | _(the board or tracker the lead routes work from; set on adoption)_ |
| Review / handback channel | _(where the leaf returns finished work for review; set on adoption)_ |
| Definition of done | _(the bar a unit clears before it bubbles up; set on adoption)_ |

Register the stream by adding its row to the root [\`board/registry.md\`](../../board/registry.md) by hand: a one-line operator action. This charter never edits the registry or any other shipped root file; it only names the row to add.

## Session start (begin)

On session start, read \`handoff.md\` if it is present and continue from where it leaves off. With no handoff, fall through cleanly to the standing structure: orient from the root board, then pick up this stream's live threads and anything the leaf has handed back for review.

## How you work

You scope, review, and surface; the operator decides and the leaf builds. Keep this charter thin: route situational detail into [\`context/\`](context/) rather than inlining it, so the class identity stays legible at a glance.
`;
}

function classLeaf(): string {
  return `# The dev leaf

Situational notes on the dev leaf this stream delegates to. This is a pointer, not a contract: the delegating-lead contract sits in the charter one level up ([\`../CLAUDE.md\`](../CLAUDE.md)). What belongs here is the concrete shape of the leaf as it stands today, filled in when the stream is adopted.

## Who the leaf is

The leaf is the executor that does the hands-on building for this stream: one scoped unit of work at a time, against acceptance criteria the lead hands down. It holds the least standing context by design and reads its task fresh each time. In a code stream it is typically a repo-scoped coding agent; in another domain it is whatever agent does the concrete work.

## Where it works

The leaf's home gets recorded here once it exists: the repository or workspace it operates in, the branch or board it draws its tasks from, and the channel it hands finished work back on. Until the stream is adopted this stays a placeholder.

## How work reaches it

Work flows down from the lead as a scoped task with its acceptance criteria attached, and flows back up as a finished unit for review. The particulars (the queue, the review cadence, the definition of done for this stream) get captured here as the stream settles into a rhythm.
`;
}

/**
 * Refuse a non-empty target unless `overwrite` is set. A non-existent or empty
 * directory writes freely; anything that is not an empty directory (a populated
 * directory or a file at the path) is refused. This is a read of the target
 * only; it never writes, so the assembly path stays disk-free with a capturing
 * writer against a non-existent target.
 *
 * Exported so `sanitize` reuses the same fresh-tree guard for its `--out`
 * directory (never in-place, mirroring `init`), rather than re-implementing it
 * (SPEC §8, subtask 2).
 */
export function guardTarget(target: string, overwrite: boolean): void {
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

/**
 * The default seam: create each parent directory and write UTF-8 LF bytes.
 *
 * Exported as the one output-tree writer both `init` and `sanitize` write
 * through: `sanitize` emits its projected `GeneratedFile[]` with the exact same
 * bytes-to-disk behaviour, so there is no second writer to drift (SPEC §8,
 * subtask 2).
 */
export const defaultWriter: FileWriter = (target, files) => {
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
