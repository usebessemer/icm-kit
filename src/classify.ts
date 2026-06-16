/**
 * The ICM classifier (SPEC §2.5).
 *
 * `classify` is the pure function at the centre of icm-kit. Given a file path,
 * the workspace tree, and the lineage `CLAUDE.md` contents, it returns the
 * file's classification under the SPEC §2.5 default table (matched in order,
 * first match wins), honouring nested L1 workspaces (§2.2), stage contracts
 * (§2.6), and load/skip-table overrides (§2.5). It evaluates no rules: that is
 * the audit runner's job (#4).
 *
 * Routing level is reported in the audit frame (§2.2). It follows from routing
 * depth (the count of `CLAUDE.md` files whose workspace contains the file, the
 * audit root counting as depth 1): depth 1 is L0, any deeper nesting is L1, and
 * a stage contract routes at L2. The exact depth integer (needed by W6 /
 * OVER_ROUTING) is the audit runner's concern, not the classifier's.
 *
 * Where the spec underspecifies a detail, the choice is marked. The load/skip
 * table *format* is an open question (SPEC §5); v0.1 uses minimal heuristics:
 * a `CLAUDE.md` "carries operations" if it contains a table with a Load or Skip
 * column, a folder is a work folder if `CLAUDE.md` names it with a trailing
 * slash, and a file is "named by" `CLAUDE.md` if its path or basename appears
 * in the text.
 */

import {
  CANONICAL_HOMES,
  IMPLIED_LOAD_PATTERN,
  ROOT_IDENTITY_FILE,
  STAGE_CONTRACT_FILE,
  STAGE_FOLDER_PATTERN,
} from './model.js';
import type { Classification, RoutingLevel } from './model.js';

/**
 * Classify one file path within its workspace (SPEC §2.5).
 *
 * @param filePath  Path relative to the audit root, POSIX-separated.
 * @param tree      Every file path in the workspace, same convention. Used to
 *                  locate nested workspaces (their `CLAUDE.md` files).
 * @param claudeMd  `CLAUDE.md` contents keyed by tree path (the lineage). Used
 *                  to parse load/skip tables and per-file references.
 */
export function classify(
  filePath: string,
  tree: readonly string[],
  claudeMd: ReadonlyMap<string, string>,
): Classification {
  const fileDir = dirOf(filePath);
  const roots = workspaceRootDirs(tree);

  // Routing depth (§2.2): every CLAUDE.md whose workspace contains this file.
  // The audit root (dir '') counts as depth 1.
  const containingRoots = roots.filter((root) => contains(root, fileDir));
  const routingDepth = containingRoots.length;

  // Nearest enclosing workspace root: the deepest containing CLAUDE.md's dir.
  const nearestRoot = containingRoots.reduce(
    (deepest, root) => (root.length > deepest.length ? root : deepest),
    '',
  );
  const relPath =
    nearestRoot === '' ? filePath : filePath.slice(nearestRoot.length + 1);

  // The enclosing workspace's CLAUDE.md text, for load/skip and mention checks.
  const enclosingKey =
    nearestRoot === ''
      ? ROOT_IDENTITY_FILE
      : `${nearestRoot}/${ROOT_IDENTITY_FILE}`;
  const enclosingClaudeMd = claudeMd.get(enclosingKey) ?? '';

  // Routing level in the audit frame (§2.2): depth 1 is L0, any nesting is L1.
  // Stage contracts override this to L2 below.
  const baseLevel: RoutingLevel = routingDepth >= 2 ? 'L1' : 'L0';

  // ---- SPEC §2.5 default table, matched in order, first match wins ----

  // Row 1: CLAUDE.md -> identity (+ operations if it carries a load/skip table).
  if (relPath === ROOT_IDENTITY_FILE) {
    return result({
      path: filePath,
      routingLevel: baseLevel,
      contentType: 'identity',
      loadPattern: IMPLIED_LOAD_PATTERN.identity,
      carriesOperations: hasLoadSkipTable(claudeMd.get(filePath) ?? ''),
    });
  }

  // Row 2: context/**/*.md -> situational, always.
  if (isUnderCanonicalHome(relPath, CANONICAL_HOMES.situational)) {
    return result({
      path: filePath,
      routingLevel: baseLevel,
      contentType: 'situational',
      loadPattern: IMPLIED_LOAD_PATTERN.situational,
    });
  }

  // Row 3: references/**/*.md -> reference, on_demand.
  if (isUnderCanonicalHome(relPath, CANONICAL_HOMES.reference)) {
    return result({
      path: filePath,
      routingLevel: baseLevel,
      contentType: 'reference',
      loadPattern: IMPLIED_LOAD_PATTERN.reference,
    });
  }

  // Row 4: NN-name/CONTEXT.md -> reference (stage contract), on_demand, at L2.
  if (isStageContract(relPath)) {
    return result({
      path: filePath,
      routingLevel: 'L2',
      contentType: 'reference',
      loadPattern: IMPLIED_LOAD_PATTERN.reference,
      stageContract: true,
    });
  }

  // Row 5: *.md under a folder the enclosing CLAUDE.md names as a work folder.
  if (isMarkdown(relPath) && isUnderWorkFolder(relPath, enclosingClaudeMd)) {
    return result({
      path: filePath,
      routingLevel: baseLevel,
      contentType: 'working',
      loadPattern: IMPLIED_LOAD_PATTERN.working,
    });
  }

  // Load/skip fallback (§2.5): evaluated after the canonical-home rows above,
  // so a canonical match wins. A file the enclosing CLAUDE.md names by hand
  // routes on demand as a reference rather than falling through to Hidden
  // context (this satisfies W5). Full type-precedence is deferred to v0.2.
  if (isMarkdown(relPath) && namedByClaudeMd(enclosingClaudeMd, relPath)) {
    return result({
      path: filePath,
      routingLevel: baseLevel,
      contentType: 'reference',
      loadPattern: IMPLIED_LOAD_PATTERN.reference,
    });
  }

  // Final row: any other file is unclassified -> Hidden context (§4.2).
  return result({ path: filePath, unclassified: true });
}

// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

/** Build a Classification, defaulting every field a branch leaves unset. */
function result(
  over: Partial<Classification> & { path: string },
): Classification {
  return {
    routingLevel: null,
    contentType: null,
    loadPattern: null,
    carriesOperations: false,
    unclassified: false,
    stageContract: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Path helpers (POSIX-relative tree paths)
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/** Workspace-root dirs: the directory of every `CLAUDE.md` in the tree. */
function workspaceRootDirs(tree: readonly string[]): string[] {
  return tree
    .filter((path) => baseOf(path) === ROOT_IDENTITY_FILE)
    .map(dirOf);
}

/** True when workspace root `root` ('' is the audit root) contains `fileDir`. */
function contains(root: string, fileDir: string): boolean {
  if (root === '') return true;
  return fileDir === root || fileDir.startsWith(`${root}/`);
}

/** True for `home/...*.md` (e.g. `context/**\/*.md`), at any depth. */
function isUnderCanonicalHome(relPath: string, home: string): boolean {
  return relPath.startsWith(`${home}/`) && isMarkdown(relPath);
}

/**
 * True for a stage-contract path: a `CONTEXT.md` whose immediate parent folder
 * is a numbered stage folder, e.g. `01-discovery/CONTEXT.md` (SPEC §2.6, W7).
 */
function isStageContract(relPath: string): boolean {
  if (baseOf(relPath) !== STAGE_CONTRACT_FILE) return false;
  const parent = baseOf(dirOf(relPath));
  return STAGE_FOLDER_PATTERN.test(parent);
}

// ---------------------------------------------------------------------------
// CLAUDE.md text heuristics (load/skip format underspecified: SPEC §5)
// ---------------------------------------------------------------------------

/** A Markdown table row whose header names a Load or Skip column. */
const LOAD_SKIP_COLUMN = /^[ \t]*\|[^\n]*\b(load|skip)\b[^\n]*\|/im;
/** A heading announcing a load/skip (or routing) table. */
const LOAD_SKIP_HEADING = /^#{1,6}[ \t]+[^\n]*\b(load\s*\/\s*skip|routing)\b/im;

/** True if a CLAUDE.md carries a load/skip table (its `operations` content). */
function hasLoadSkipTable(content: string): boolean {
  return LOAD_SKIP_COLUMN.test(content) || LOAD_SKIP_HEADING.test(content);
}

/**
 * True when `relPath`'s top-level folder is named as a work folder by the
 * enclosing CLAUDE.md: the folder appears with a trailing slash, and is not a
 * canonical home or a numbered stage folder.
 */
function isUnderWorkFolder(relPath: string, claudeMd: string): boolean {
  const slash = relPath.indexOf('/');
  if (slash === -1) return false; // a work product lives under a folder
  const folder = relPath.slice(0, slash);
  if (folder === CANONICAL_HOMES.situational) return false;
  if (folder === CANONICAL_HOMES.reference) return false;
  if (STAGE_FOLDER_PATTERN.test(folder)) return false;
  return mentionsToken(claudeMd, `${folder}/`);
}

/**
 * True when the enclosing CLAUDE.md names `relPath` explicitly: by its full
 * relative path, or by its basename in a path-like context (so `priorities.md`
 * does not match inside `old-priorities.md`).
 */
function namedByClaudeMd(claudeMd: string, relPath: string): boolean {
  if (mentionsToken(claudeMd, relPath)) return true;
  return mentionsToken(claudeMd, baseOf(relPath));
}

/** True if `token` appears in `text` not preceded by a word or hyphen char. */
function mentionsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRegExp(token)}`).test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
