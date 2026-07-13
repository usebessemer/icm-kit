/**
 * The `sanitize` projection classifier (SPEC §8).
 *
 * `classifyProjection` is the foundation layer for `sanitize`: given a file
 * path in a workspace, it assigns a *projection home* and the *projection rule*
 * that home carries, or fails closed (`unclassified`) on anything it cannot
 * confidently home. It is a first-match-wins path-rule table (SPEC §8.2),
 * evaluated in the order of the SPEC table's rows.
 *
 * It is a distinct layer from `classify()` (SPEC §2.5), not an overload of it:
 * `classify()` only inspects `*.md` and only emits four content types, so it
 * cannot name `settings.json`, hooks, the root companions, `sync/`, secrets,
 * boards, registries, decision logs, or channels: every file `sanitize` must
 * home but `classify()` never sees. The projection table is authoritative and
 * path-based. It *composes* with `classify()` for the Markdown ICM homes it
 * does cover: `classify()` supplies the base content type, and the projection
 * splits that base finer than `classify()`'s four types can (memory vs context
 * are both `situational`; the personal `voice` file is split out of the
 * `reference` bucket, which is `sanitize`'s own distinction, SPEC §8.3).
 *
 * No redaction here. `shape_only`, `redact_instance`, `omit`, and
 * `omit_assert_absence` are only *classifications* of intent at this layer; the
 * transforms and the fail-closed enforcement land in a later subtask.
 */

import { classify } from './classify.js';
import {
  CANONICAL_HOMES,
  PROJECTION_HOME_RULE,
  ROOT_IDENTITY_FILE,
  SKILL_FILE,
} from './model.js';
import type { ProjectionClassification, ProjectionHome } from './model.js';
import { baseName, dirOf, isMarkdown, isUnderArchive } from './paths.js';

/** The Claude-Code harness home; every file under it is harness (SPEC §8.2). */
const HARNESS_HOME = '.claude';

/** Root companion docs, matched by basename (SPEC §8.2 row 4). */
const ROOT_COMPANIONS: ReadonlySet<string> = new Set([
  'CONVENTIONS.md',
  'EXPANSIONS.md',
  'connections.md',
  'README.md',
]);

/** Harness settings files, matched by basename (SPEC §8.2 row 5). */
const HARNESS_SETTINGS: ReadonlySet<string> = new Set([
  'settings.json',
  'settings.local.json',
]);

/**
 * The one personal-reference file split out of `references/` as its own home
 * (SPEC §8.2 row 11, §8.3). v1 is this exact path; it generalizes to a
 * configurable personal-reference list later (SPEC §8.3, not built now).
 */
const VOICE_FILE = `${CANONICAL_HOMES.reference}/voice.md`;

/**
 * Classify one file path for `sanitize`'s projection (SPEC §8.2).
 *
 * @param filePath  Path relative to the workspace root, POSIX-separated.
 * @param tree      Every file path in the workspace; passed through to
 *                  `classify()` for the Markdown ICM homes (SPEC §8.2 rows
 *                  9 to 12).
 * @param claudeMd  `CLAUDE.md` contents keyed by tree path (the lineage), used
 *                  by `classify()` the same way.
 */
export function classifyProjection(
  filePath: string,
  tree: readonly string[],
  claudeMd: ReadonlyMap<string, string>,
): ProjectionClassification {
  const base = baseName(filePath);

  // ---- SPEC §8.2 rule table, matched in order, first match wins ----

  // Row 1: any CLAUDE.md (root or a nested workspace) -> router.
  if (base === ROOT_IDENTITY_FILE) return home('router', filePath);

  // Row 2: .claude/skills/<slug>/SKILL.md -> skill.
  if (isSkillFile(filePath)) return home('skill', filePath);

  // Row 3: any other .claude/** file (hooks, harness config) -> harness. This
  // precedes the secret and settings rows, so a settings.json or a secret-named
  // file living under .claude/ is homed here (still pass_through).
  if (isUnderDir(filePath, HARNESS_HOME)) return home('harness', filePath);

  // Row 4: root companion docs, by basename -> companion.
  if (ROOT_COMPANIONS.has(base)) return home('companion', filePath);

  // Row 5: settings.json / settings.local.json (outside .claude/) -> harness.
  if (HARNESS_SETTINGS.has(base)) return home('harness', filePath);

  // Row 6: sync/** -> sync.
  if (isUnderDir(filePath, 'sync')) return home('sync', filePath);

  // Row 7: secrets-shaped paths -> secret (the fail-closed omit + absence
  // assertion, enforced in a later subtask).
  if (isSecretShaped(filePath)) return home('secret', filePath);

  // Row 8: archives/** -> archive. Named explicitly even though the workspace
  // reader already drops archives (its IGNORED_NAMES / isUnderArchive), so the
  // omit is tested and explicit, not merely incidental to the walk (SPEC §8.3).
  if (isUnderArchive(filePath)) return home('archive', filePath);

  // Rows 9 to 12: the Markdown ICM homes. classify() (SPEC §2.5) supplies the
  // base content type; the projection splits it finer (SPEC §8.3): `.memory/`
  // vs `context/` are both `situational`, and `voice.md` is split out of the
  // `reference` bucket. A Markdown file classify() types as neither situational
  // nor reference (a working product, a stage file, an orphan) falls through to
  // the instance-record row and then fails closed.
  if (isMarkdown(filePath)) {
    const icm = classify(filePath, tree, claudeMd);
    if (icm.contentType === 'situational') {
      // Row 9
      if (isUnderDir(filePath, CANONICAL_HOMES.memory)) {
        return home('memory', filePath);
      }
      // Row 10
      if (isUnderDir(filePath, CANONICAL_HOMES.situational)) {
        return home('context', filePath);
      }
    }
    if (icm.contentType === 'reference') {
      // Row 11
      if (filePath === VOICE_FILE) return home('voice', filePath);
      // Row 12
      if (isUnderDir(filePath, CANONICAL_HOMES.reference)) {
        return home('reference', filePath);
      }
    }
  }

  // Row 13: instance-scoped coordination records -> instance_record (the
  // redaction depth is a later subtask; here we only get the paths into the
  // right bucket, SPEC §8.3).
  if (isInstanceRecord(filePath)) return home('instance_record', filePath);

  // Final row: anything matching no rule fails closed. Never a silent
  // pass-through: the caller treats this as a hard error (SPEC §8.2).
  return { path: filePath, home: null, rule: null, unclassified: true };
}

// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

/**
 * Build a homed classification. The rule is read from the model's home-to-rule
 * map, so the classifier never restates a rule inline and cannot drift from the
 * SPEC §8.2 table (the "spec wins on disagreement" discipline).
 */
function home(h: ProjectionHome, path: string): ProjectionClassification {
  return { path, home: h, rule: PROJECTION_HOME_RULE[h], unclassified: false };
}

// ---------------------------------------------------------------------------
// Projection-local path predicates
// ---------------------------------------------------------------------------

/** True for a path under directory `dir` (root-anchored, POSIX-relative). */
function isUnderDir(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

/**
 * True only for `.claude/skills/<slug>/SKILL.md` (SPEC §8.2 row 2). A dedicated
 * predicate, not a generic `.claude/skills/` prefix, so a stray file in the
 * skills tree is not mistaken for a skill definition (it stays row 3 harness).
 */
function isSkillFile(path: string): boolean {
  if (baseName(path) !== SKILL_FILE) return false;
  return dirOf(dirOf(path)) === CANONICAL_HOMES.skill;
}

/**
 * True for a secrets-shaped path (SPEC §8.2 row 7), case-insensitive on the
 * basename: a dotenv file (`.env`, `.env.local`), a `*token*` or `*credential*`
 * basename, or any path under a `secrets/` directory at any depth.
 */
function isSecretShaped(path: string): boolean {
  const base = baseName(path).toLowerCase();
  if (base.startsWith('.env')) return true;
  if (base.includes('token')) return true;
  if (base.includes('credential')) return true;
  return path.split('/').some((segment) => segment.toLowerCase() === 'secrets');
}

/**
 * True for an instance-scoped coordination record (SPEC §8.2 row 13): a file
 * under `board/`, `decisions/`, or `channels/`, or a `registry.md`. These carry
 * live workspace instance state, so the projection redacts rather than passes
 * them (the redaction depth is a later subtask).
 */
function isInstanceRecord(path: string): boolean {
  if (isUnderDir(path, 'board')) return true;
  if (baseName(path) === 'registry.md') return true;
  if (isUnderDir(path, 'decisions')) return true;
  return isUnderDir(path, 'channels');
}
