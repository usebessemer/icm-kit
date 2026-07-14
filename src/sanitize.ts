/**
 * The `sanitize` projection engine, gate, and manifest (SPEC §8, support mode).
 *
 * Where `project.ts` (subtask 1) only *classifies* every file into a projection
 * home and its rule, this module *applies* those rules: it turns a read
 * `Workspace` into the `GeneratedFile[]` output tree a shareable bundle is made
 * of, plus the reviewable manifest and the fail-closed gate that guard it.
 *
 * The projection is pure and disk-free: it classifies every file first, applies
 * each home's transform in memory, and returns the output tree, one manifest
 * entry per source file, and a gate verdict. The CLI (`cli.ts`) is the only
 * layer that touches disk: it aborts on a failing gate *before* any file is
 * written (classify-all-first), guards a fresh `--out`, then writes through the
 * one shared writer (`defaultWriter`, reused from `init.ts`).
 *
 * The four emitting transforms (SPEC §8.2):
 * - `pass_through`  -> the file verbatim (LF-normalized on read); a binary is
 *                      omitted instead, with a manifest line (v1: text only).
 * - `shape_only`    -> keep a leading frontmatter block and every heading;
 *                      replace each section's body prose with a redaction marker.
 * - `redact_instance` -> keep frontmatter, every heading, and each table's
 *                      column header + delimiter (the structural skeleton);
 *                      redact all body prose and every table data row. The
 *                      conservative, aggressive, structure-only default for the
 *                      genuine open decision on redaction depth (SPEC §8.3).
 * - `omit` / `omit_assert_absence` -> excluded from the tree; the secret rule
 *                      additionally records a loud gate finding and asserts its
 *                      content never leaks into an emitted file.
 *
 * Honest boundary (stated in the manifest, SPEC §8): the redaction is
 * home-based. It redacts the homes where private instance concentrates; it does
 * not hunt for arbitrary names inside `pass_through` structural files (an
 * unbounded problem). Residual names in structural files are the required
 * independent leak-check's job; the tool feeds that pass, it does not replace it.
 */

import type { GeneratedFile } from './init.js';
import { SPEC_VERSION } from './model.js';
import type { ProjectionHome, ProjectionRule } from './model.js';
import { classifyProjection } from './project.js';
import { splitSections } from './parse.js';
import type { Workspace } from './workspace.js';

/** The projection modes (SPEC §8). Only `support` is built in this subtask. */
export const PROJECTION_MODES = ['support', 'extract'] as const;
export type ProjectionMode = (typeof PROJECTION_MODES)[number];

/** What a source file became in the projected tree. */
export type Disposition = 'emit' | 'omit';

/**
 * One manifest entry: what the projection did to one source file. Every source
 * file produces exactly one entry, whether it was emitted, shaped, redacted, or
 * omitted, so the manifest is a complete account of the run (SPEC §8).
 */
export interface ProjectionEntry {
  /** Source path, POSIX-relative (SPEC §8.2). */
  readonly path: string;
  readonly home: ProjectionHome | null;
  readonly rule: ProjectionRule | null;
  /** `emit` -> a file in the output tree; `omit` -> excluded from it. */
  readonly disposition: Disposition;
  /** Short reason, e.g. `verbatim`, `shaped`, `redacted`, `omitted: secret-shaped`. */
  readonly note: string;
  /** Non-blank source lines, for the before/after summary (emitting rules). */
  readonly sourceLines?: number;
  /** Lines that survived to the output, for the before/after summary. */
  readonly keptLines?: number;
  /** The exact bytes emitted for a shaped/redacted file: the survived skeleton. */
  readonly survived?: string;
}

/**
 * The gate verdict (SPEC §8, support-mode gate). `ok` is false when anything
 * fails closed: an `unclassified` file (a hard error: nothing is written), or a
 * secret whose content leaked into an emitted file (must never happen; asserted
 * for defence in depth).
 */
export interface GateResult {
  readonly ok: boolean;
  /** Files matching no §8.2 rule: fail closed, the run must not write. */
  readonly unclassified: readonly string[];
  /**
   * `omit_assert_absence` matches present in the *source*. Normal (a private
   * workspace holds secrets); recorded loudly and asserted absent from `--out`,
   * not a failure by itself.
   */
  readonly secretsPresent: readonly string[];
  /** Secret content that appeared in an emitted file: a leak, fail closed. */
  readonly leaked: readonly string[];
}

/** The whole result of projecting a workspace in support mode (SPEC §8). */
export interface ProjectionResult {
  readonly mode: ProjectionMode;
  readonly specVersion: string;
  /** One entry per source file, in the workspace's sorted tree order. */
  readonly entries: readonly ProjectionEntry[];
  /** The projected output tree (emitted files only), sorted by path. */
  readonly files: readonly GeneratedFile[];
  readonly gate: GateResult;
}

/** The redaction marker written in place of removed prose (SPEC §8.2). */
function redactionMarker(count: number, unit: 'lines' | 'rows'): string {
  return `<!-- redacted: ${count} ${unit} -->`;
}

// ---------------------------------------------------------------------------
// Typed errors (init-style: the CLI prints these cleanly, never a stack trace)
// ---------------------------------------------------------------------------

/** Thrown when `--mode` is anything support mode does not (yet) implement. */
export class UnsupportedModeError extends Error {
  constructor(public readonly mode: string) {
    const known = mode === 'extract'
      ? `mode "extract" is not built yet (it arrives in a later subtask)`
      : `unknown mode "${mode}"`;
    super(`${known}; use --mode support`);
    this.name = 'UnsupportedModeError';
  }
}

/** Thrown when `--out` is not given: support mode always writes a fresh tree. */
export class OutputRequiredError extends Error {
  constructor() {
    super('an output directory is required: pass --out <dir>');
    this.name = 'OutputRequiredError';
  }
}

/**
 * Thrown when the gate fails closed: one or more files matched no §8.2 rule.
 * Carries the offending paths so the CLI can list them. Nothing is written.
 */
export class UnclassifiedFilesError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `${paths.length} file(s) matched no projection rule (fail closed; nothing written):\n` +
        paths.map((p) => `  ${p}`).join('\n'),
    );
    this.name = 'UnclassifiedFilesError';
  }
}

/**
 * Thrown when a secret's content was found inside an emitted file: the secrets
 * guarantee (omit AND assert absent) failed. This must never happen given the
 * transforms never copy secret content; asserted anyway for defence in depth.
 */
export class SecretLeakError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `secret content leaked into the projected tree (fail closed; nothing written):\n` +
        paths.map((p) => `  ${p}`).join('\n'),
    );
    this.name = 'SecretLeakError';
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Project a read workspace into its shareable support-mode tree (SPEC §8).
 *
 * Pure and disk-free: classifies every file, applies each home's transform in
 * memory, and returns the output tree, the per-file manifest entries, and the
 * gate verdict. It never writes and never throws on a failing gate: the caller
 * inspects `result.gate` (or calls `assertGate`) and decides. This keeps
 * "classify all first, write nothing on failure" a property the CLI enforces
 * before touching disk.
 */
export function projectSupport(workspace: Workspace): ProjectionResult {
  const { tree, claudeMd, files } = workspace;

  const entries: ProjectionEntry[] = [];
  const outFiles: GeneratedFile[] = [];
  const unclassified: string[] = [];
  const secretsPresent: string[] = [];
  const secretContents: string[] = [];

  for (const file of files) {
    const c = classifyProjection(file.path, tree, claudeMd);

    if (c.unclassified) {
      unclassified.push(file.path);
      entries.push({
        path: file.path,
        home: null,
        rule: null,
        disposition: 'omit',
        note: 'unclassified (fail closed): no §8.2 rule matched',
      });
      continue;
    }

    const rule = c.rule as ProjectionRule;
    const home = c.home as ProjectionHome;

    if (rule === 'omit_assert_absence') {
      secretsPresent.push(file.path);
      if (file.isText && file.content.trim() !== '') secretContents.push(file.content);
      entries.push(omitEntry(file.path, home, rule, 'secret-shaped'));
      continue;
    }
    if (rule === 'omit') {
      entries.push(omitEntry(file.path, home, rule, 'archived content'));
      continue;
    }

    // Emitting rules: pass_through / shape_only / redact_instance. A binary is
    // never projected in v1: it is omitted with a manifest line, not silently
    // dropped (SPEC §8.2, pass_through note).
    if (!file.isText) {
      entries.push(omitEntry(file.path, home, rule, 'binary (not projected in v1)'));
      continue;
    }

    const projected = applyRule(rule, file.content);
    outFiles.push({ path: file.path, content: projected.content });
    entries.push({
      path: file.path,
      home,
      rule,
      disposition: 'emit',
      note: projected.note,
      sourceLines: projected.sourceLines,
      keptLines: projected.keptLines,
      survived: projected.survived,
    });
  }

  const leaked = detectLeaks(secretContents, outFiles);
  const gate: GateResult = {
    ok: unclassified.length === 0 && leaked.length === 0,
    unclassified,
    secretsPresent,
    leaked,
  };

  return { mode: 'support', specVersion: SPEC_VERSION, entries, files: outFiles, gate };
}

/**
 * Throw the fail-closed error the gate implies, or return cleanly when it
 * passes. The CLI calls this after `projectSupport` and before any disk write,
 * so an unclassified file or a secret leak aborts with nothing written.
 */
export function assertGate(result: ProjectionResult): void {
  if (result.gate.unclassified.length > 0) {
    throw new UnclassifiedFilesError(result.gate.unclassified);
  }
  if (result.gate.leaked.length > 0) {
    throw new SecretLeakError(result.gate.leaked);
  }
}

function omitEntry(
  path: string,
  home: ProjectionHome,
  rule: ProjectionRule,
  why: string,
): ProjectionEntry {
  return { path, home, rule, disposition: 'omit', note: `omitted: ${why}` };
}

/** The result of one emitting transform: its bytes plus a manifest summary. */
interface Applied {
  readonly content: string;
  readonly note: string;
  readonly sourceLines: number;
  readonly keptLines: number;
  /** The survived skeleton for shape_only / redact_instance; undefined verbatim. */
  readonly survived?: string;
}

/** Dispatch one emitting rule to its transform (SPEC §8.2). */
function applyRule(rule: ProjectionRule, content: string): Applied {
  const sourceLines = proseLineCount(content);
  if (rule === 'pass_through') {
    return { content, note: 'verbatim', sourceLines, keptLines: sourceLines };
  }
  const out = rule === 'shape_only' ? shapeOnly(content) : redactInstance(content);
  const keptLines = proseLineCount(out);
  return {
    content: out,
    note: rule === 'shape_only' ? 'shaped' : 'redacted',
    sourceLines,
    keptLines,
    survived: out,
  };
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * `shape_only` (SPEC §8.2): keep the frontmatter *keys* and every heading
 * *level*; redact the frontmatter *values*, the heading *text*, and each
 * section's body prose. Only the structural skeleton (frontmatter shape, heading
 * levels, section count) survives; all instance-specific content is gone.
 * Frontmatter values and heading text are redacted, not kept, because both are
 * content and never navigation: the AIOS `.memory/` `description:` field and a
 * heading like `## Call with <name> re: <deal>` are among the most private lines
 * in the file (PR #62, Stu's resolved redaction-depth decision, SPEC §8.4).
 */
export function shapeOnly(content: string): string {
  const { frontmatter, rest } = splitFrontmatter(content);
  const out: string[] = [];
  if (frontmatter !== null) out.push(redactFrontmatter(frontmatter));
  for (const section of splitSections(rest)) {
    if (section.level > 0) out.push(redactedHeading(section.level));
    const n = proseLineCount(section.body);
    if (n > 0) out.push(redactionMarker(n, 'lines'));
  }
  return finalize(out);
}

/**
 * `redact_instance` (SPEC §8.2): keep the frontmatter keys, every heading
 * *level*, and each Markdown table's column-header and delimiter rows (the
 * structural skeleton); redact the frontmatter values, the heading text, every
 * table data row, and all other body prose.
 *
 * The resolved redaction-depth decision (SPEC §8.3, PR #62): aggressive,
 * structure-only. Heading text redacts (a dated decision heading like
 * `## 2026-06-01 - Acme terms` collapses to `## <!-- redacted heading -->`, its
 * level preserved as shape); status *values* (OPEN / ACTIONED) sit in data rows
 * and so are redacted, only the column header that names them surviving;
 * frontmatter values redact as in `shape_only`. Over-redact and let a reviewer
 * re-widen, never the reverse.
 */
export function redactInstance(content: string): string {
  const { frontmatter, rest } = splitFrontmatter(content);
  const out: string[] = [];
  if (frontmatter !== null) out.push(redactFrontmatter(frontmatter));
  for (const section of splitSections(rest)) {
    if (section.level > 0) out.push(redactedHeading(section.level));
    out.push(...redactBody(section.body));
  }
  return finalize(out);
}

/**
 * Redact one section body, keeping table skeletons. Contiguous prose lines
 * collapse to one `redacted: N lines` marker; a table (a header row followed by
 * a delimiter row) keeps its header and delimiter and collapses its data rows
 * to one `redacted: N rows` marker. Blank lines are dropped so the output is
 * compact and deterministic.
 */
function redactBody(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let proseRun = 0;
  const flushProse = (): void => {
    if (proseRun > 0) {
      out.push(redactionMarker(proseRun, 'lines'));
      proseRun = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isTableHeader(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushProse();
      out.push(line); // column headers: structural, kept
      out.push(lines[i + 1]); // delimiter: structural, kept
      i += 2;
      let rows = 0;
      while (i < lines.length && isTableRow(lines[i])) {
        rows += 1;
        i += 1;
      }
      if (rows > 0) out.push(redactionMarker(rows, 'rows'));
      continue;
    }
    if (line.trim() !== '') proseRun += 1;
    i += 1;
  }
  flushProse();
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter, headings, tables, counting
// ---------------------------------------------------------------------------

/**
 * Split a leading YAML frontmatter block off the content. A frontmatter block
 * is a `---` line at the very start, up to the next `---` line. Returns the
 * block verbatim (fences included) plus the remainder after it, or a null block
 * when none is present. The AIOS `.memory/` format carries `name` /
 * `description` / `metadata` frontmatter whose values are private, so
 * `redactFrontmatter` redacts those values while the keys survive (SPEC §8.4).
 */
export function splitFrontmatter(content: string): {
  frontmatter: string | null;
  rest: string;
} {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { frontmatter: null, rest: content };
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      return {
        frontmatter: lines.slice(0, i + 1).join('\n'),
        rest: lines.slice(i + 1).join('\n'),
      };
    }
  }
  // An unterminated `---` is not frontmatter; treat the whole file as body.
  return { frontmatter: null, rest: content };
}

/** The marker a redacted frontmatter value is replaced with (PR #62 review B1). */
const FRONTMATTER_REDACTION = '<!-- redacted -->';

/**
 * Redact the values of a YAML frontmatter block, keeping the keys and the block
 * structure as shape (PR #62 review B1, SPEC §8.4). A value is content and never
 * navigation, so redacting it costs nothing structural: a reviewer fixing
 * frontmatter *shape* needs the keys, not the values.
 *
 * Line-based and conservative, so it does not need a YAML parser and fails
 * toward redaction on anything it does not recognise:
 * - `---` fences and blank lines survive verbatim (structure).
 * - `key:` with an empty value survives (a mapping parent / block opener; its
 *   children are redacted on their own lines).
 * - `key: value` keeps `key:` and redacts the value; a `- key: value` list-map
 *   entry keeps its `- ` and key too.
 * - `- scalar` keeps the `- ` list marker and redacts the item.
 * - anything else (a bare scalar, a block-scalar continuation) is redacted
 *   whole, keeping only its indentation.
 */
function redactFrontmatter(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      if (line === '---' || line.trim() === '') return line;
      const mapping = /^(\s*)(-\s+)?([\w.$-]+):(\s*)(.*)$/.exec(line);
      if (mapping) {
        const [, indent, dash = '', key, , value] = mapping;
        if (value.trim() === '') return line; // parent key: keep as shape
        return `${indent}${dash}${key}: ${FRONTMATTER_REDACTION}`;
      }
      const listItem = /^(\s*)-\s+.*$/.exec(line);
      if (listItem) return `${listItem[1]}- ${FRONTMATTER_REDACTION}`;
      const indent = /^(\s*)/.exec(line)![1];
      return `${indent}${FRONTMATTER_REDACTION}`;
    })
    .join('\n');
}

/**
 * A redacted heading: keep the `#`-level prefix as structural shape (section
 * count and nesting depth survive), redact the text (PR #62, Stu's resolved
 * redaction-depth decision). Same-level headings collapsing to identical
 * redacted forms is intended and deterministic: the shape is what survives, the
 * text (potential content) is gone, so the redacted homes carry no caveat.
 */
function redactedHeading(level: number): string {
  return `${'#'.repeat(level)} <!-- redacted heading -->`;
}

/** Non-blank line count: the honest number of prose lines a marker stands in for. */
function proseLineCount(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/** A candidate table row: non-blank and containing a pipe. */
function isTableHeader(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/** A Markdown table delimiter row: only pipes, dashes, colons, spaces; has a dash. */
function isTableDelimiter(line: string): boolean {
  const t = line.trim();
  return t.includes('-') && /^\|?[\s:|-]+\|?$/.test(t);
}

/** A table data row: a pipe-bearing non-blank line that is not a delimiter. */
function isTableRow(line: string): boolean {
  return isTableHeader(line) && !isTableDelimiter(line);
}

/** Join projected lines into a file body with a single trailing newline. */
function finalize(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/**
 * The secret-absence assertion (SPEC §8, secrets gate): any emitted file whose
 * content contains a secret file's content verbatim is a leak. A belt-and-
 * suspenders check: the transforms never copy secret content, so this is empty
 * by construction, but a real leak must fail closed rather than ship. Reports
 * the emitted path where the leak surfaced.
 */
function detectLeaks(
  secretContents: readonly string[],
  outFiles: readonly GeneratedFile[],
): string[] {
  const leaked: string[] = [];
  for (const file of outFiles) {
    for (const secret of secretContents) {
      if (file.content.includes(secret)) {
        leaked.push(file.path);
        break;
      }
    }
  }
  return leaked;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The honest home-based-redaction boundary, stated in every manifest (SPEC §8).
 * A reviewer must know exactly what the tool did and did not guarantee before
 * the required independent leak-check.
 */
const BOUNDARY_NOTE = [
  'Boundary (read before you push):',
  '  This redaction is home-based. In the redacted homes (memory, context, voice,',
  '  and the coordination records) only the structural skeleton survives (heading',
  '  levels, table column-headers and delimiters, frontmatter keys); all heading',
  '  text, body prose, table data, and frontmatter values are redacted, and',
  '  secrets and archives are omitted. It does NOT scan pass_through structural',
  '  files (routers, companions, harness, sync, references) for arbitrary names:',
  "  that is unbounded, and is the required independent leak-check's job. This",
  '  manifest feeds that human pass, it does not replace it. Ratification stays',
  '  human: review this manifest, then copy the output tree out.',
].join('\n');

/**
 * Render the reviewable manifest for a projection (SPEC §8): a summary header
 * (counts per rule, the SPEC version, the gate verdict), the honest boundary
 * note, and one line per source file with its applied rule and, for a
 * shaped/redacted file, the before/after skeleton that survived. Pure: the same
 * result renders the same string.
 */
export function renderManifest(result: ProjectionResult): string {
  const { entries, gate, specVersion, files } = result;
  const lines: string[] = [];

  lines.push(`icm-kit sanitize --mode support (SPEC ${specVersion})`);
  lines.push('');

  const byRule = countByRule(entries);
  lines.push('Summary:');
  lines.push(`  ${entries.length} file(s) classified; ${files.length} emitted, ${
    entries.length - files.length
  } omitted.`);
  lines.push(`  pass_through: ${byRule.pass_through}   shape_only: ${byRule.shape_only}   redact_instance: ${byRule.redact_instance}`);
  lines.push(`  omit: ${byRule.omit}   omit_assert_absence (secret): ${byRule.omit_assert_absence}   unclassified: ${byRule.unclassified}`);
  lines.push('');

  lines.push(`Gate: ${gate.ok ? 'PASS' : 'FAIL'}`);
  lines.push(
    `  secrets in source (omitted, asserted absent from output): ${
      gate.secretsPresent.length === 0 ? 'none' : ''
    }`,
  );
  for (const p of gate.secretsPresent) {
    lines.push(`    secrets-shaped file present: ${p} (omitted from projection)`);
  }
  if (gate.unclassified.length > 0) {
    lines.push('  UNCLASSIFIED (fail closed, nothing written):');
    for (const p of gate.unclassified) lines.push(`    ${p}`);
  }
  if (gate.leaked.length > 0) {
    lines.push('  SECRET LEAK (fail closed, nothing written):');
    for (const p of gate.leaked) lines.push(`    ${p}`);
  }
  lines.push('');

  lines.push(BOUNDARY_NOTE);
  lines.push('');

  lines.push('Files:');
  for (const e of entries) {
    lines.push(`  ${e.path}`);
    const homeRule = e.home ? `${e.home} / ${e.rule}` : 'unclassified';
    lines.push(`      ${homeRule}: ${e.note}${beforeAfter(e)}`);
    if (e.survived !== undefined && e.survived.trim() !== '') {
      for (const survived of e.survived.replace(/\n$/, '').split('\n')) {
        lines.push(`        | ${survived}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** The `(N lines -> M kept)` before/after fragment for an emitting entry. */
function beforeAfter(e: ProjectionEntry): string {
  if (e.sourceLines === undefined || e.keptLines === undefined) return '';
  if (e.rule === 'pass_through') return ` (${e.sourceLines} lines)`;
  return ` (${e.sourceLines} lines -> ${e.keptLines} kept)`;
}

/** Count entries by projection rule for the manifest summary. */
function countByRule(entries: readonly ProjectionEntry[]): Record<string, number> {
  const counts: Record<string, number> = {
    pass_through: 0,
    shape_only: 0,
    redact_instance: 0,
    omit: 0,
    omit_assert_absence: 0,
    unclassified: 0,
  };
  for (const e of entries) {
    const key = e.rule ?? 'unclassified';
    counts[key] += 1;
  }
  return counts;
}
