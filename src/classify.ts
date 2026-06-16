/**
 * The ICM classifier (SPEC §2.5).
 *
 * `classify` is the pure function at the centre of icm-kit. Given a file path,
 * the workspace tree, and the lineage `CLAUDE.md` contents, it returns the
 * file's classification under the SPEC §2.5 default table (matched in order,
 * first match wins), honouring nested L1 workspaces (§2.2), stage contracts
 * (§2.6), and the load/skip fallback (§2.5). It evaluates no rules: that is the
 * audit runner's job (#4).
 *
 * Routing level is reported in the audit frame (§2.2). It follows from routing
 * depth (the count of `CLAUDE.md` files whose workspace contains the file, the
 * audit root counting as depth 1): depth 1 is L0, any deeper nesting is L1, and
 * a stage contract routes at L2. The exact depth integer (needed by W6 /
 * OVER_ROUTING) is the audit runner's concern, not the classifier's.
 *
 * Path, workspace-root, and text helpers are shared with the audit runner via
 * `paths` and `parse`, so the two cannot drift.
 */

import {
  CANONICAL_HOMES,
  IMPLIED_LOAD_PATTERN,
  ROOT_IDENTITY_FILE,
  STAGE_CONTRACT_FILE,
  STAGE_FOLDER_PATTERN,
} from './model.js';
import type { Classification, RoutingLevel } from './model.js';
import {
  baseName,
  dirOf,
  isMarkdown,
  nearestRoot,
  routingDepth,
} from './paths.js';
import { hasLoadSkipTable, mentionsToken, namedByClaudeMd } from './parse.js';

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
  const depth = routingDepth(filePath, tree);
  const root = nearestRoot(filePath, tree);
  const relPath = root === '' ? filePath : filePath.slice(root.length + 1);

  // The enclosing workspace's CLAUDE.md text, for load/skip and mention checks.
  const enclosingKey =
    root === '' ? ROOT_IDENTITY_FILE : `${root}/${ROOT_IDENTITY_FILE}`;
  const enclosingClaudeMd = claudeMd.get(enclosingKey) ?? '';

  // Routing level in the audit frame (§2.2): depth 1 is L0, any nesting is L1.
  // Stage contracts override this to L2 below.
  const baseLevel: RoutingLevel = depth >= 2 ? 'L1' : 'L0';

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
// Classify-local path predicates
// ---------------------------------------------------------------------------

/** True for `home/...*.md` (e.g. `context/**\/*.md`), at any depth. */
function isUnderCanonicalHome(relPath: string, home: string): boolean {
  return relPath.startsWith(`${home}/`) && isMarkdown(relPath);
}

/**
 * True for a stage-contract path: a `CONTEXT.md` whose immediate parent folder
 * is a numbered stage folder, e.g. `01-discovery/CONTEXT.md` (SPEC §2.6, W7).
 */
function isStageContract(relPath: string): boolean {
  if (baseName(relPath) !== STAGE_CONTRACT_FILE) return false;
  return STAGE_FOLDER_PATTERN.test(baseName(dirOf(relPath)));
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
