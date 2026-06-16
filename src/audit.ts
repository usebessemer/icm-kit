/**
 * The audit runner (SPEC §3, §4).
 *
 * `audit` walks a read workspace, classifies every file (§2.5), and evaluates
 * the well-formedness rules (W1 to W7) and failure modes (F1 to F6) from the
 * rule model, returning a sorted list of findings. Every finding carries a
 * stable rule code; failure modes that enforce a well-formedness rule also
 * carry the `relatedRule` they back (e.g. HIDDEN_CONTEXT enforces W5).
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
 *   not prose; the omission bullet and time-based heuristics are deferred.
 * - F1 size caps stay at the spec defaults: a crude "egregiously huge" guard,
 *   not tuned to reproduce any hand-audit (SPEC §5 q3).
 */

import { classify } from './classify.js';
import {
  DEFAULT_THRESHOLDS,
  FAILURE_MODES,
  ROOT_IDENTITY_FILE,
  STAGE_CONTRACT_SECTIONS,
  WELL_FORMEDNESS_RULES,
} from './model.js';
import type { Classification, Finding, Severity, Thresholds } from './model.js';
import { baseName, dirOf, isMarkdown, routingDepth } from './paths.js';
import {
  extractLoadSkipPointers,
  hasBehaviourBlock,
  hasLoadSkipTable,
  isIdentityHeading,
  parseStageContract,
  splitSections,
} from './parse.js';
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

/** Audit a read workspace against W1 to W7 and F1 to F6 (SPEC §3, §4). */
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
  const isClaudeMd = baseName(file.path) === ROOT_IDENTITY_FILE;
  const cap = isClaudeMd
    ? thresholds.claudeMdMaxTokens
    : thresholds.fileMaxTokens;
  // Unreadable or non-UTF-8 files have empty text; fall back to a byte-based
  // estimate so a binary monolith can still trip the size guard.
  const estimated = file.content.length === 0 && file.bytes > 0;
  const tokens = estimated
    ? Math.ceil(file.bytes / 4)
    : countTokens(file.content);
  if (tokens > cap) {
    findings.push({
      rule: F.F1,
      severity: WARNING,
      path: file.path,
      message: `File is ${tokens} tokens${estimated ? ' (estimated from bytes)' : ''}, over the ${cap}-token cap for ${isClaudeMd ? 'a CLAUDE.md' : 'a single file'} (F1 MONOLITHIC_CONTEXT).`,
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
  for (const pointer of extractLoadSkipPointers(content)) {
    const resolved = root === '' ? pointer : `${root}/${pointer}`;
    if (treeSet.has(resolved) || treeSet.has(pointer)) continue;
    findings.push({
      rule: F.F3,
      severity: WARNING,
      path: claudePath,
      message: `Load/skip table points to a file that does not exist: ${pointer} (F3 STALE_CONTENT).`,
    });
  }
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
    for (const pointer of extractLoadSkipPointers(content)) {
      if (treeSet.has(pointer) && routingDepth(pointer, tree) >= 2) {
        findings.push({
          rule: F.F5,
          severity: WARNING,
          path: claudePath,
          message: `Root CLAUDE.md routes a task at a child-workspace file (${pointer}): the operations content belongs in the child (F5 LAYER_BLOAT).`,
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
// Ordering
// ---------------------------------------------------------------------------

/** Sort findings by path, then rule code, for deterministic output. */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });
}
