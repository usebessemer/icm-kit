/**
 * The audit runner (SPEC §3, §4).
 *
 * `audit` walks a read workspace, classifies every file (§2.5), and evaluates
 * the well-formedness rules (W1 to W7) and failure modes (F1 to F6, plus F8)
 * from the rule model, returning a sorted list of findings. Every finding
 * carries a stable rule code; failure modes that enforce a well-formedness rule
 * also carry the `relatedRule` they back (e.g. HIDDEN_CONTEXT enforces W5).
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
 *   prose is expected rather than drift.
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
import { baseName, dirOf, isMarkdown, routingDepth } from './paths.js';
import {
  extractLoadSkipReferences,
  findDuplicateProse,
  hasBehaviourBlock,
  hasLoadSkipTable,
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

/** Audit a read workspace against W1 to W7 and F1 to F6, plus F8 (SPEC §3, §4). */
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
    checkStageContract(file, c, findings);
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
// Stale content (F3) and layer bloat (F5)
// ---------------------------------------------------------------------------

function checkStaleContent(
  claudePath: string,
  content: string,
  treeSet: Set<string>,
  findings: Finding[],
): void {
  const root = dirOf(claudePath);
  for (const ref of extractLoadSkipReferences(content)) {
    if (ref.structural) continue; // a per-folder convention placeholder
    if (resolveExisting(ref, root, treeSet) !== undefined) continue;
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
 * relative to the CLAUDE.md's workspace root; `undefined` if none resolve.
 */
function resolveExisting(
  ref: LoadSkipReference,
  root: string,
  treeSet: Set<string>,
): string | undefined {
  for (const candidate of ref.candidates) {
    if (treeSet.has(candidate)) return candidate;
    if (root !== '' && treeSet.has(`${root}/${candidate}`)) {
      return `${root}/${candidate}`;
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
    findings.push(duplicationFinding(left, right));
    findings.push(duplicationFinding(right, left));
  }
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
 * Excludes unclassified files (F2's concern, not duplication), the always-loaded
 * `.memory/` store and auto-discovered skills (shared or templated prose there
 * is expected), numbered-stage work files (per-item artifacts), and retired
 * `archives/` content (a live file vs its own archived copy is the correct route,
 * not drift; `archives/` is also stripped by the workspace walker's ignore list,
 * so this guard covers only in-memory trees).
 */
function isDuplicationCandidate(file: WorkspaceFile, c: Classification): boolean {
  if (!file.isText || c.unclassified) return false;
  const segments = file.path.split('/');
  if (segments[0] === CANONICAL_HOMES.memory) return false;
  if (file.path.startsWith(`${CANONICAL_HOMES.skill}/`)) return false;
  if (segments.includes('archives')) return false;
  if (c.contentType === 'working' && c.routingLevel === 'L2') return false;
  return true;
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
