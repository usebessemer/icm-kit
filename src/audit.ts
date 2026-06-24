/**
 * The audit runner (SPEC §3, §4).
 *
 * `audit` walks a read workspace, classifies every file (§2.5), and evaluates
 * the well-formedness rules (W1 to W7) and failure modes (F1 to F9) from the
 * rule model, returning a sorted list of findings. Every finding carries a
 * stable rule code; failure modes that enforce a well-formedness rule also carry
 * the `relatedRule` they back (e.g. HIDDEN_CONTEXT enforces W5).
 *
 * v0.1 scope notes (each surfaced in the PR, none silently absorbed):
 * - W4 NESTED_INTEGRITY is implemented by running W1 to W3 across every
 *   workspace (root and nested), so a nested violation surfaces under its own
 *   W code at the nested path, rather than as a distinct W4 finding.
 * - W3 / F1 soft signal detect the content-MIXING case (a non-CLAUDE file with
 *   a dense embedded behaviour block). Detecting wrong-home placement by
 *   content inference is a later refinement.
 * - F5 LAYER_BLOAT keys off section size + heading shape, not marker density
 *   (which inverts on directive-dense ops manuals): a large CLAUDE.md section
 *   that is neither the load/skip table nor a recognisably identity heading.
 *   Coarse and heading-dependent by design (SPEC §4.5, v0.1 limitation).
 * - F3 STALE_CONTENT reads pointers from the load/skip table only (SPEC §4.3),
 *   not prose, and resolves each within its cell: a bare name is tried against
 *   a same-cell directory token, and a bare structural basename (CONTEXT.md /
 *   CLAUDE.md) is treated as a placeholder. The omission bullet and time-based
 *   heuristics are deferred.
 * - F1 size caps stay at the spec defaults: a crude "egregiously huge" guard,
 *   not tuned to reproduce any hand-audit (SPEC §5 q3).
 * - F8 DUPLICATION is whole-workspace, not per-file: it compares the prose
 *   blocks of every pair of classified text files by Jaccard over word shingles
 *   (SPEC §4.8). The candidate set excludes unclassified files (F2's concern),
 *   the always-loaded `.memory/` store, auto-discovered skills, numbered-stage
 *   work files, and retired `archives/` content, where shared or templated
 *   prose is expected rather than drift. Beyond the candidate set, two work
 *   products are not flagged against each other (templated deliverables share
 *   structure by design), but a work product duplicating durable content is.
 * - F9 SUPERSEDED_BUT_LIVE is per-file: a live-routed Markdown file (classified,
 *   not under `archives/`) whose top region opens with a superseded/deprecated
 *   banner (SPEC §4.9). It backs W5 from the opposite side of F2: F2 routes a
 *   hidden file in, F9 routes a self-marked-dead file out.
 * - F7 KIT_BOILERPLATE is per-file and the first rule to read git history: a
 *   tracked, routed text file that existed at the fork-point commit and that no
 *   commit since has touched is upstream boilerplate the workspace never adapted
 *   (SPEC §4.7). Git facts ride on `WorkspaceFile` (one seam, set by
 *   `readWorkspace`); the harness/work homes where "untouched since fork" is
 *   expected (`.memory/`, numbered-stage work files, `archives/`) are exempt, as
 *   is CLAUDE.md. Off-repo the facts default to untracked, so F7 stays silent.
 */

import { classify } from './classify.js';
import {
  CANONICAL_HOMES,
  DEFAULT_THRESHOLDS,
  FAILURE_MODES,
  ROOT_IDENTITY_FILE,
  STAGE_CONTRACT_SECTIONS,
  WELL_FORMEDNESS_RULES,
} from './model.js';
import type { Classification, Finding, Severity, Thresholds } from './model.js';
import {
  baseName,
  dirOf,
  isMarkdown,
  isUnderArchive,
  normalizePosix,
  routingDepth,
} from './paths.js';
import {
  extractLoadSkipReferences,
  findDuplicateProse,
  hasBehaviourBlock,
  hasLoadSkipTable,
  hasSupersededBanner,
  isAppendOnlyLog,
  isIdentityHeading,
  parseStageContract,
  splitSections,
} from './parse.js';
import type { DuplicationInput, LoadSkipReference } from './parse.js';
import { DEFAULT_TOKEN_COUNTER } from './tokens.js';
import type { TokenCounter } from './tokens.js';
import type { Workspace, WorkspaceFile } from './workspace.js';

const W = WELL_FORMEDNESS_RULES;
const F = FAILURE_MODES;
const WARNING: Severity = 'warning';

/** A section heading that announces the permitted load/skip table (§2.3). */
const LOAD_SKIP_HEADING = /\b(load\s*\/\s*skip|routing)\b/i;

/** Options for a run; both fall back to the SPEC v0.1 defaults. */
export interface AuditOptions {
  readonly thresholds?: Thresholds;
  readonly countTokens?: TokenCounter;
}

/** Audit a read workspace against W1 to W7 and F1 to F9 (SPEC §3, §4). */
export function audit(workspace: Workspace, options: AuditOptions = {}): Finding[] {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const countTokens = options.countTokens ?? DEFAULT_TOKEN_COUNTER;
  const { tree, files, claudeMd } = workspace;
  const treeSet = new Set(tree);

  const classifications = new Map<string, Classification>();
  for (const file of files) {
    classifications.set(file.path, classify(file.path, tree, claudeMd));
  }

  const findings: Finding[] = [];

  checkRootIdentity(treeSet, findings);
  checkSingleRootIdentity(files, findings);

  for (const file of files) {
    const c = classifications.get(file.path)!;
    checkRoutable(file.path, c, findings);
    checkOverRouting(file.path, tree, thresholds, findings);
    checkMonolithicSize(file, countTokens, thresholds, findings);
    checkContentSegregation(file, c, findings);
    checkSupersededBanner(file, c, thresholds, findings);
    checkStageContract(file, c, findings);
    checkKitBoilerplate(file, c, findings);
  }

  for (const [claudePath, content] of claudeMd) {
    checkStaleContent(claudePath, content, treeSet, findings);
    checkLayerBloat(claudePath, content, tree, treeSet, countTokens, thresholds, findings);
  }

  // Whole-workspace pass (after the per-file loop), like the identity checks.
  checkDuplication(files, classifications, countTokens, thresholds, findings);

  return sortFindings(findings);
}

// ---------------------------------------------------------------------------
// Well-formedness: identity (W1, W2; W4 via per-workspace recursion)
// ---------------------------------------------------------------------------

function checkRootIdentity(treeSet: Set<string>, findings: Finding[]): void {
  if (!treeSet.has(ROOT_IDENTITY_FILE)) {
    findings.push({
      rule: W.W1,
      severity: WARNING,
      path: ROOT_IDENTITY_FILE,
      message: 'No CLAUDE.md at the workspace root (W1 ROOT_IDENTITY).',
    });
  }
}

function checkSingleRootIdentity(
  files: readonly WorkspaceFile[],
  findings: Finding[],
): void {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    if (/^claude\.md$/i.test(baseName(file.path))) {
      const dir = dirOf(file.path);
      const list = byDir.get(dir) ?? [];
      list.push(file.path);
      byDir.set(dir, list);
    }
  }
  for (const [dir, identities] of byDir) {
    if (identities.length > 1) {
      const sorted = [...identities].sort();
      findings.push({
        rule: W.W2,
        severity: WARNING,
        path: sorted[0],
        message: `Competing root identity files in ${dir || 'the workspace root'}: ${sorted.join(', ')} (W2 SINGLE_ROOT_IDENTITY).`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Routability (W5 / F2) and routing depth (W6 / F4)
// ---------------------------------------------------------------------------

function checkRoutable(
  path: string,
  c: Classification,
  findings: Finding[],
): void {
  if (isMarkdown(path) && c.unclassified) {
    findings.push({
      rule: F.F2,
      severity: WARNING,
      path,
      message:
        'No routing path: not in a canonical home and not named by any CLAUDE.md (F2 HIDDEN_CONTEXT).',
      relatedRule: W.W5,
    });
  }
}

function checkOverRouting(
  path: string,
  tree: readonly string[],
  thresholds: Thresholds,
  findings: Finding[],
): void {
  const depth = routingDepth(path, tree);
  if (depth > thresholds.maxRoutingDepth) {
    findings.push({
      rule: F.F4,
      severity: WARNING,
      path,
      message: `Routing depth ${depth} exceeds the maximum of ${thresholds.maxRoutingDepth} (F4 OVER_ROUTING).`,
      relatedRule: W.W6,
    });
  }
}

// ---------------------------------------------------------------------------
// Monolithic content (F1) and content segregation (F1 soft signal / W3)
// ---------------------------------------------------------------------------

function checkMonolithicSize(
  file: WorkspaceFile,
  countTokens: TokenCounter,
  thresholds: Thresholds,
  findings: Finding[],
): void {
  // The size check applies to UTF-8 text only; a binary or unreadable file is
  // not token-counted, because a byte count is not a meaningful token estimate
  // for a binary format (SPEC §4.1).
  if (!file.isText) return;
  const isClaudeMd = baseName(file.path) === ROOT_IDENTITY_FILE;
  // An append-only log (a decisions log, an async channel) is an accreting
  // ledger that grows by design; it is exempt from the size cap, since the
  // remedy is a tail-archive of old entries, not a split (SPEC §4.1). The
  // exemption never applies to a CLAUDE.md: the L0 identity cap holds even if
  // the file happens to carry dated headings.
  if (!isClaudeMd && isAppendOnlyLog(file.content)) return;
  const cap = isClaudeMd
    ? thresholds.claudeMdMaxTokens
    : thresholds.fileMaxTokens;
  const tokens = countTokens(file.content);
  if (tokens > cap) {
    findings.push({
      rule: F.F1,
      severity: WARNING,
      path: file.path,
      message: `File is ${tokens} tokens, over the ${cap}-token cap for ${isClaudeMd ? 'a CLAUDE.md' : 'a single file'} (F1 MONOLITHIC_CONTEXT).`,
    });
  }
}

function checkContentSegregation(
  file: WorkspaceFile,
  c: Classification,
  findings: Finding[],
): void {
  // CLAUDE.md is the one file permitted to mix content types (§2.3).
  if (baseName(file.path) === ROOT_IDENTITY_FILE) return;
  if (!isMarkdown(file.path) || c.unclassified) return;
  if (hasBehaviourBlock(file.content)) {
    findings.push({
      rule: F.F1,
      severity: WARNING,
      path: file.path,
      message: `A ${c.contentType} file carries a dense embedded behaviour block: it mixes content types (F1 soft signal / W3 CONTENT_SEGREGATION).`,
      relatedRule: W.W3,
    });
  }
}

// ---------------------------------------------------------------------------
// Superseded-but-live (F9 / W5)
// ---------------------------------------------------------------------------

/**
 * F9 SUPERSEDED_BUT_LIVE (SPEC §4.9): a file carrying a superseded/deprecated
 * banner near its top that is still classified into a live (non-archive) home,
 * so the agent still reads it as current. The inverse of HIDDEN_CONTEXT (F2): F2
 * is an unreachable file that should be routed, F9 is a reachable file the author
 * marked dead that should be un-routed; both back W5. An unclassified banner file
 * is F2's job (never read), and a file already under `archives/` is correctly
 * retired, so both are skipped.
 */
function checkSupersededBanner(
  file: WorkspaceFile,
  c: Classification,
  thresholds: Thresholds,
  findings: Finding[],
): void {
  if (!isMarkdown(file.path) || c.unclassified || isUnderArchive(file.path)) return;
  if (!hasSupersededBanner(file.content, thresholds.supersededBannerScanLines)) return;
  findings.push({
    rule: F.F9,
    severity: WARNING,
    path: file.path,
    message: `Carries a superseded banner but is still routed as live ${c.contentType}: move it to archives/ (F9 SUPERSEDED_BUT_LIVE).`,
    relatedRule: W.W5,
  });
}

// ---------------------------------------------------------------------------
// Stage contracts (W7 / F6)
// ---------------------------------------------------------------------------

function checkStageContract(
  file: WorkspaceFile,
  c: Classification,
  findings: Finding[],
): void {
  if (!c.stageContract) return;
  const { missing, empty } = parseStageContract(
    file.content,
    STAGE_CONTRACT_SECTIONS,
  );
  if (missing.length === 0 && empty.length === 0) return;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (empty.length > 0) parts.push(`empty ${empty.join(', ')}`);
  findings.push({
    rule: F.F6,
    severity: WARNING,
    path: file.path,
    message: `Malformed stage contract: ${parts.join('; ')} (F6 MALFORMED_STAGE_CONTRACT).`,
    relatedRule: W.W7,
  });
}

// ---------------------------------------------------------------------------
// Kit boilerplate (F7)
// ---------------------------------------------------------------------------

/**
 * F7 KIT_BOILERPLATE (SPEC §4.7): a file inherited from the workspace's fork or
 * import point and never adapted since. The fire condition reads the git facts
 * `readWorkspace` attached to the file (`tracked`, `existedAtForkPoint`,
 * `postForkCommits === 0`): present at the fork point, untouched after it.
 *
 * Scoped to classified, routable text files. Exemptions: CLAUDE.md (identity
 * starts from a template; other rules govern it); binaries (no meaningful
 * content to adapt); unrouted files (F2's concern, not boilerplate); and the
 * harness/work homes where "untouched since fork" is the expected state, not a
 * defect: the always-loaded `.memory/` store, numbered-stage work files, and
 * retired `archives/`. Auto-discovered skills are deliberately not exempt: an
 * un-adapted kit skill is exactly what this rule targets. Off-repo the git facts
 * default to untracked, so the rule is silent (no relatedRule).
 */
function checkKitBoilerplate(
  file: WorkspaceFile,
  c: Classification,
  findings: Finding[],
): void {
  if (!file.isText) return;
  if (baseName(file.path) === ROOT_IDENTITY_FILE) return;
  if (c.unclassified) return;
  if (pathUnderHome(file.path, CANONICAL_HOMES.memory)) return;
  if (isStageScratch(c)) return;
  if (isUnderArchive(file.path)) return;
  if (!file.tracked || !file.existedAtForkPoint || file.postForkCommits !== 0) {
    return;
  }
  findings.push({
    rule: F.F7,
    severity: WARNING,
    path: file.path,
    message:
      'Inherited from the fork point and never adapted since (no commit after the fork point has touched it): adapt it to this workspace or move it to archives/ (F7 KIT_BOILERPLATE).',
  });
}

/**
 * True for an L2 numbered-stage work file: transient per-task scratch (SPEC §2.5,
 * §4.7/§4.8). Shared by KIT_BOILERPLATE and the DUPLICATION candidate guard so
 * the two cannot drift on what a stage-scratch file is.
 */
function isStageScratch(c: Classification): boolean {
  return c.contentType === 'working' && c.routingLevel === 'L2';
}

// ---------------------------------------------------------------------------
// Stale content (F3) and layer bloat (F5)
// ---------------------------------------------------------------------------

function checkStaleContent(
  claudePath: string,
  content: string,
  treeSet: Set<string>,
  findings: Finding[],
): void {
  const root = dirOf(claudePath);
  // Dedup per stale token: a pointer repeated across N load/skip cells is one
  // stale reference, so it earns one finding, not N (SPEC §4.3). The key is the
  // literal token, not the resolved path: two cells naming the same bare
  // basename (e.g. `_template.md`) intentionally merge, since the message is
  // token-only and the two findings would otherwise be indistinguishable.
  const seen = new Set<string>();
  for (const ref of extractLoadSkipReferences(content)) {
    if (ref.structural) continue; // a per-folder convention placeholder
    if (resolveExisting(ref, root, treeSet) !== undefined) continue;
    if (seen.has(ref.token)) continue;
    seen.add(ref.token);
    findings.push({
      rule: F.F3,
      severity: WARNING,
      path: claudePath,
      message: `Load/skip table points to a file that does not exist: ${ref.token} (F3 STALE_CONTENT).`,
    });
  }
}

/**
 * The first candidate of `ref` that exists in the tree, tried as-is and
 * relative to the containing CLAUDE.md's directory; `undefined` if none resolve.
 * Each candidate is POSIX-normalized (collapsing `.`/`..`) before the membership
 * test, so a relative pointer from a nested CLAUDE.md (`../../context/f.md`)
 * resolves against the tree's normalized paths rather than failing on its
 * literal `..` segments (SPEC §4.3). The resolved path is returned normalized.
 */
function resolveExisting(
  ref: LoadSkipReference,
  root: string,
  treeSet: Set<string>,
): string | undefined {
  for (const candidate of ref.candidates) {
    const direct = normalizePosix(candidate);
    if (treeSet.has(direct)) return direct;
    if (root !== '') {
      const joined = normalizePosix(`${root}/${candidate}`);
      if (treeSet.has(joined)) return joined;
    }
  }
  return undefined;
}

function checkLayerBloat(
  claudePath: string,
  content: string,
  tree: readonly string[],
  treeSet: Set<string>,
  countTokens: TokenCounter,
  thresholds: Thresholds,
  findings: Finding[],
): void {
  // Variant A: the root CLAUDE.md routes tasks at files that live only inside a
  // child workspace; that operations content belongs in the child (§4.5).
  if (claudePath === ROOT_IDENTITY_FILE) {
    for (const ref of extractLoadSkipReferences(content)) {
      const resolved = resolveExisting(ref, '', treeSet);
      if (resolved !== undefined && routingDepth(resolved, tree) >= 2) {
        findings.push({
          rule: F.F5,
          severity: WARNING,
          path: claudePath,
          message: `Root CLAUDE.md routes a task at a child-workspace file (${resolved}): the operations content belongs in the child (F5 LAYER_BLOAT).`,
        });
      }
    }
  }

  // Variant B: a large CLAUDE.md section that is neither the permitted load/skip
  // table nor recognisably identity is misplaced operations or situational
  // prose (§4.5). Keyed off size + heading shape, not marker density: real ops
  // manuals are directive-dense and would escape a density filter. The identity
  // preamble (level 0) is exempt; F1 backstops a headingless monolith.
  for (const section of splitSections(content)) {
    if (section.level === 0) continue;
    if (isIdentityHeading(section.heading)) continue;
    if (LOAD_SKIP_HEADING.test(section.heading)) continue;
    if (hasLoadSkipTable(section.body)) continue;
    const tokens = countTokens(section.body);
    if (tokens > thresholds.layerBloatProseTokens) {
      findings.push({
        rule: F.F5,
        severity: WARNING,
        path: claudePath,
        message: `Large non-identity block in "${section.heading}" (${tokens} tokens, over ${thresholds.layerBloatProseTokens}): operations or situational content at the wrong level (F5 LAYER_BLOAT).`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Duplication (F8)
// ---------------------------------------------------------------------------

/**
 * F8 DUPLICATION (SPEC §4.8): the same substantive prose living in two
 * separately-routed homes. A whole-workspace check: it compares the prose
 * blocks of every pair of candidate files by Jaccard over word shingles, and
 * emits one finding per side of a duplicated pair, each naming the other path.
 */
function checkDuplication(
  files: readonly WorkspaceFile[],
  classifications: Map<string, Classification>,
  countTokens: TokenCounter,
  thresholds: Thresholds,
  findings: Finding[],
): void {
  const candidates: DuplicationInput[] = [];
  for (const file of files) {
    const c = classifications.get(file.path)!;
    if (isDuplicationCandidate(file, c)) {
      candidates.push({ path: file.path, content: file.content });
    }
  }
  const pairs = findDuplicateProse(candidates, {
    shingleSize: thresholds.duplicationShingleSize,
    similarityFloor: thresholds.duplicationSimilarityFloor,
    minBlockTokens: thresholds.duplicationMinBlockTokens,
    countTokens,
  });
  for (const { left, right } of pairs) {
    // Two work products are not flagged against each other: templated
    // deliverables across engagements share structure by design (§4.8). A work
    // product duplicating durable content (identity/situational/reference) is
    // still flagged, since that is the cross-home drift F8 targets.
    if (
      isWorkProduct(classifications.get(left)!) &&
      isWorkProduct(classifications.get(right)!)
    ) {
      continue;
    }
    findings.push(duplicationFinding(left, right));
    findings.push(duplicationFinding(right, left));
  }
}

/** True for a per-item work product (a `working` file, at any routing level). */
function isWorkProduct(c: Classification): boolean {
  return c.contentType === 'working';
}

/** One side of a duplicated pair: `path`, naming the `other` it duplicates. */
function duplicationFinding(path: string, other: string): Finding {
  return {
    rule: F.F8,
    severity: WARNING,
    path,
    message: `Substantive prose duplicated with ${other}: consolidate to one routed home (F8 DUPLICATION).`,
  };
}

/**
 * True when a file belongs in the DUPLICATION candidate set (SPEC §4.8 guards).
 * Excludes unclassified files (F2's concern, not duplication); the always-loaded
 * `.memory/` store and auto-discovered skills, matched at any depth so a nested
 * workspace's harness homes are covered too (shared or templated prose there is
 * expected); numbered-stage work files (transient per-task scratch, a structural
 * harness home); and retired `archives/` content (a live file vs its own archived
 * copy is the correct route, not drift; `archives/` is also stripped by the
 * workspace walker's ignore list, so this guard covers only in-memory trees).
 *
 * Declared-work-folder deliverables (e.g. `clients/`, `engagements/`) stay in the
 * candidate set; the both-work-products pair guard in `checkDuplication` keeps two
 * deliverables from flagging each other while still catching a deliverable that
 * duplicates durable content.
 */
function isDuplicationCandidate(file: WorkspaceFile, c: Classification): boolean {
  if (!file.isText || c.unclassified) return false;
  if (pathUnderHome(file.path, CANONICAL_HOMES.memory)) return false;
  if (pathUnderHome(file.path, CANONICAL_HOMES.skill)) return false;
  if (isUnderArchive(file.path)) return false;
  if (isStageScratch(c)) return false;
  return true;
}

/**
 * True when `home` (a `/`-joined folder name like `.memory` or `.claude/skills`)
 * appears as a run of consecutive path segments in `path`, at any depth. Segment
 * matching, not substring, so `team.claude/skills/x` does not match `.claude/skills`
 * and `archives-2024/x` does not match `archives`.
 */
function pathUnderHome(path: string, home: string): boolean {
  const segments = path.split('/');
  const homeSegments = home.split('/');
  for (let i = 0; i + homeSegments.length <= segments.length; i += 1) {
    if (homeSegments.every((seg, k) => segments[i + k] === seg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Sort findings by path, then rule code, then message, for deterministic
 * output. The message tiebreaker matters for F8: a file duplicating two
 * different others yields two findings at the same path and rule, distinguished
 * only by the path each message names (SPEC §4.8 mustFix).
 */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}
