/**
 * The `sanitize` projection engine, gate, and manifest (SPEC §8, both modes).
 *
 * Where `project.ts` (subtask 1) only *classifies* every file into a projection
 * home and its rule, this module *applies* those rules: it turns a read
 * `Workspace` into the `GeneratedFile[]` output tree a shareable bundle is made
 * of, plus the reviewable manifest and the fail-closed gate that guard it.
 *
 * Two modes share one pipeline (classify-all-first, fail-closed, deterministic)
 * and every transform below:
 * - `projectSupport` (§8.4): the whole-workspace remote-support bundle. Every
 *   file is classified and projected under its §8.2 rule.
 * - `projectExtract` (§8.5): the scoped capability harvest. Only the `--include`
 *   set (each file under its §8.2 rule) and the *minimal routing context* (the
 *   enclosing `CLAUDE.md`(s) up to the audit root, forced to `shape_only` so
 *   routing survives but the router's personal content does not) are emitted;
 *   everything else is intentionally omitted. Public-destined, so §8.6's
 *   independent leak-check is a required downstream stage the manifest states.
 *
 * The projection is pure and disk-free: it classifies every in-scope file first,
 * applies each home's transform in memory, and returns the output tree, one
 * manifest entry per in-scope file, and a gate verdict. The CLI (`cli.ts`) is
 * the only layer that touches disk: it aborts on a failing gate *before* any
 * file is written (classify-all-first), guards a fresh `--out`, then writes
 * through the one shared writer (`defaultWriter`, reused from `init.ts`).
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
import { ROOT_IDENTITY_FILE, SPEC_VERSION } from './model.js';
import type { ProjectionHome, ProjectionRule } from './model.js';
import { classifyProjection } from './project.js';
import { splitSections } from './parse.js';
import { containingRoots } from './paths.js';
import type { Workspace, WorkspaceFile } from './workspace.js';

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

/** The whole result of projecting a workspace (SPEC §8, either mode). */
export interface ProjectionResult {
  readonly mode: ProjectionMode;
  readonly specVersion: string;
  /**
   * One entry per in-scope source file, in the workspace's sorted tree order.
   * Support mode's scope is every file; extract mode's scope is the include set
   * plus its routing chain (§8.5), so an out-of-scope file has no entry.
   */
  readonly entries: readonly ProjectionEntry[];
  /** The projected output tree (emitted files only), sorted by path. */
  readonly files: readonly GeneratedFile[];
  readonly gate: GateResult;
  /**
   * Extract mode only (§8.5): the requested `--include` set, normalized. The
   * manifest lists it so a reviewer sees the scope that was asked for.
   * Undefined in support mode.
   */
  readonly includes?: readonly string[];
  /**
   * Extract mode only (§8.5): the routing `CLAUDE.md` paths the include set
   * pulled in (shape-redacted), sorted. The manifest lists these so a reviewer
   * sees exactly what the scope pulled beyond the includes. Undefined in
   * support mode.
   */
  readonly routing?: readonly string[];
}

/** The redaction marker written in place of removed prose (SPEC §8.2). */
function redactionMarker(count: number, unit: 'lines' | 'rows'): string {
  return `<!-- redacted: ${count} ${unit} -->`;
}

// ---------------------------------------------------------------------------
// Typed errors (init-style: the CLI prints these cleanly, never a stack trace)
// ---------------------------------------------------------------------------

/** Thrown when `--mode` is neither of the two implemented modes. */
export class UnsupportedModeError extends Error {
  constructor(public readonly mode: string) {
    super(`unknown mode "${mode}"; use --mode support or --mode extract`);
    this.name = 'UnsupportedModeError';
  }
}

/**
 * Thrown when `--mode extract` is run with no `--include` path: extract has no
 * meaningful default scope, so an empty include set is a typed user error, not
 * an empty projection (SPEC §8.5). Nothing is written.
 */
export class IncludeRequiredError extends Error {
  constructor() {
    super(
      'extract mode requires at least one --include <path>: pass --include <paths...> (a file or a directory prefix)',
    );
    this.name = 'IncludeRequiredError';
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
  const acc = newAccumulator();

  for (const file of files) {
    const c = classifyProjection(file.path, tree, claudeMd);
    if (c.unclassified) {
      accumulateUnclassified(acc, file.path);
      continue;
    }
    accumulate(acc, projectClassified(file, c.home as ProjectionHome, c.rule as ProjectionRule));
  }

  return { mode: 'support', specVersion: SPEC_VERSION, ...finishAccumulator(acc) };
}

/**
 * Project a scoped capability harvest (SPEC §8.5): the `--include` set (each
 * file under its §8.2 rule) plus the *minimal routing context* that lets it
 * stand alone, and nothing else.
 *
 * The minimal routing context is, for every included file, the `CLAUDE.md` at
 * each of its containing workspace roots, from the nearest enclosing root up to
 * the audit root (the §2.2 routing frame `containingRoots` closes over, the
 * same one `nearestRoot` / `routingDepth` are built on). Each routing
 * `CLAUDE.md` is forced to `shape_only`, overriding its support-mode
 * `pass_through`: routing survives (the include is not orphaned) but the
 * router's personal identity does not, because extract output is
 * public-destined. A file that is both an include target and a routing ancestor
 * is shape-redacted (routing wins), so no `CLAUDE.md` is ever emitted verbatim.
 *
 * Only in-scope files (includes + routing) are classified, projected, and
 * accounted for; everything else is intentionally omitted and absent from the
 * output and the manifest. The gate is support mode's, scoped to those files:
 * an unclassified *included* file still fails closed; an out-of-scope
 * unclassified file cannot, because extract never emits it.
 *
 * Pure and disk-free, like `projectSupport`: it never writes and never throws
 * on a failing gate. The caller inspects `result.gate` (or `assertGate`).
 */
export function projectExtract(
  workspace: Workspace,
  includePaths: readonly string[],
): ProjectionResult {
  const { tree, claudeMd, files } = workspace;
  const includes = normalizeIncludes(includePaths);

  // The routing chain: every containing-root CLAUDE.md of every included file.
  const routingPaths = new Set<string>();
  for (const file of files) {
    if (!matchesInclude(file.path, includes)) continue;
    for (const rootDir of containingRoots(file.path, tree)) {
      routingPaths.add(routingClaudePath(rootDir));
    }
  }

  const acc = newAccumulator();
  const routing: string[] = [];

  for (const file of files) {
    const isRouting = routingPaths.has(file.path);
    const isTarget = matchesInclude(file.path, includes);
    if (!isRouting && !isTarget) continue; // out of scope: not emitted, not accounted

    // Routing wins over an include target: a CLAUDE.md that is both is shaped,
    // never passed through, so extract emits no verbatim router (§8.5).
    if (isRouting) {
      const projected = projectClassified(file, 'router', 'shape_only');
      accumulate(acc, {
        ...projected,
        entry: { ...projected.entry, note: `routing context (shape_only): ${projected.entry.note}` },
      });
      if (projected.file) routing.push(file.path);
      continue;
    }

    const c = classifyProjection(file.path, tree, claudeMd);
    if (c.unclassified) {
      accumulateUnclassified(acc, file.path);
      continue;
    }
    accumulate(acc, projectClassified(file, c.home as ProjectionHome, c.rule as ProjectionRule));
  }

  return {
    mode: 'extract',
    specVersion: SPEC_VERSION,
    ...finishAccumulator(acc),
    includes,
    routing,
  };
}

// ---------------------------------------------------------------------------
// Shared projection machinery (both modes)
// ---------------------------------------------------------------------------

/** The pieces one in-scope file contributes to a projection accumulator. */
interface ProjectedFile {
  readonly entry: ProjectionEntry;
  /** The emitted file, for an emitting rule; absent for an omit. */
  readonly file?: GeneratedFile;
  /** True when the file is a secret present in source (`omit_assert_absence`). */
  readonly secretPresent?: boolean;
  /** The secret's content, for the absence assertion (a non-blank text secret). */
  readonly secretContent?: string;
}

/**
 * Project one classified file into its manifest entry plus, for an emitting
 * rule, the emitted file (and, for a secret, its content for the absence
 * assertion). Shared by both modes so support and extract cannot drift on how a
 * §8.2 rule turns a source file into output (SPEC §8.4).
 */
function projectClassified(
  file: WorkspaceFile,
  home: ProjectionHome,
  rule: ProjectionRule,
): ProjectedFile {
  if (rule === 'omit_assert_absence') {
    const isLiveSecret = file.isText && file.content.trim() !== '';
    return {
      entry: omitEntry(file.path, home, rule, 'secret-shaped'),
      secretPresent: true,
      secretContent: isLiveSecret ? file.content : undefined,
    };
  }
  if (rule === 'omit') {
    return { entry: omitEntry(file.path, home, rule, 'archived content') };
  }
  // Emitting rules: pass_through / shape_only / redact_instance. A binary is
  // never projected in v1: it is omitted with a manifest line, not silently
  // dropped (SPEC §8.4, pass_through note).
  if (!file.isText) {
    return { entry: omitEntry(file.path, home, rule, 'binary (not projected in v1)') };
  }
  const projected = applyRule(rule, file.content);
  return {
    file: { path: file.path, content: projected.content },
    entry: {
      path: file.path,
      home,
      rule,
      disposition: 'emit',
      note: projected.note,
      sourceLines: projected.sourceLines,
      keptLines: projected.keptLines,
      survived: projected.survived,
    },
  };
}

/** The mutable accumulator both modes fold their in-scope files into. */
interface Accumulator {
  readonly entries: ProjectionEntry[];
  readonly outFiles: GeneratedFile[];
  readonly unclassified: string[];
  readonly secretsPresent: string[];
  readonly secretContents: string[];
}

function newAccumulator(): Accumulator {
  return { entries: [], outFiles: [], unclassified: [], secretsPresent: [], secretContents: [] };
}

/** Fold one projected file's entry, emitted file, and secret facts in. */
function accumulate(acc: Accumulator, projected: ProjectedFile): void {
  acc.entries.push(projected.entry);
  if (projected.file) acc.outFiles.push(projected.file);
  if (projected.secretPresent) acc.secretsPresent.push(projected.entry.path);
  if (projected.secretContent !== undefined) acc.secretContents.push(projected.secretContent);
}

/** Record a fail-closed unclassified file (SPEC §8.2 final row). */
function accumulateUnclassified(acc: Accumulator, path: string): void {
  acc.unclassified.push(path);
  acc.entries.push({
    path,
    home: null,
    rule: null,
    disposition: 'omit',
    note: 'unclassified (fail closed): no §8.2 rule matched',
  });
}

/** Close an accumulator into the entries, output tree, and gate verdict. */
function finishAccumulator(acc: Accumulator): {
  entries: ProjectionEntry[];
  files: GeneratedFile[];
  gate: GateResult;
} {
  const leaked = detectLeaks(acc.secretContents, acc.outFiles);
  const gate: GateResult = {
    ok: acc.unclassified.length === 0 && leaked.length === 0,
    unclassified: acc.unclassified,
    secretsPresent: acc.secretsPresent,
    leaked,
  };
  return { entries: acc.entries, files: acc.outFiles, gate };
}

// ---------------------------------------------------------------------------
// Extract-mode scope helpers (SPEC §8.5)
// ---------------------------------------------------------------------------

/**
 * Normalize `--include` paths for matching: collapse `.`/`..` and strip
 * trailing slashes, so `.claude/skills/example/` and `./.claude/skills/example`
 * both become `.claude/skills/example`. An empty include (`.` or `/`, which
 * normalizes to `''`) means the whole workspace root and matches every file.
 */
function normalizeIncludes(includePaths: readonly string[]): string[] {
  return includePaths.map((p) =>
    p
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.')
      .join('/'),
  );
}

/** True when `path` is the include itself or sits beneath a directory include. */
function matchesInclude(path: string, includes: readonly string[]): boolean {
  return includes.some((inc) => inc === '' || path === inc || path.startsWith(`${inc}/`));
}

/** The `CLAUDE.md` path at a workspace root dir (`''` is the audit root). */
function routingClaudePath(rootDir: string): string {
  return rootDir === '' ? ROOT_IDENTITY_FILE : `${rootDir}/${ROOT_IDENTITY_FILE}`;
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
 * The extract-mode boundary + required-leak-check protocol (SPEC §8.5, §8.6).
 * Extract output is public-destined, so the manifest states plainly that the
 * machine pass is necessary but not sufficient: an independent adversarial
 * leak-check is a required pipeline stage, referencing the on-record precedent.
 */
const EXTRACT_BOUNDARY_NOTE = [
  'Boundary and required leak-check (extract mode; read before you push):',
  '  This is a SCOPED projection for PUBLIC-destined output. It emits ONLY the',
  '  include set (each file under its projection rule) and the minimal routing',
  '  context (the enclosing CLAUDE.md(s) up to the audit root, shape-redacted);',
  '  everything else in the workspace is intentionally omitted. Pass_through',
  '  targets (a skill SKILL.md, a shared reference) are emitted VERBATIM: the',
  '  tool does not scan them for arbitrary names.',
  '  For public output an independent adversarial leak-check is a REQUIRED',
  '  pipeline stage, not an option. The machine pass mechanizes the redaction',
  '  RULES; the leak-check verifies the OUTCOME. Precedent (2026-07-05): an',
  "  author's own sanitization pass missed a live email, a raw spec, and real",
  '  customer names; independent eyes caught all three pre-push. The machine pass',
  '  FEEDS the adversarial pass, it never SUBSTITUTES for it. Ratification stays',
  '  human: review this manifest and the tree, run the leak-check, then copy out.',
].join('\n');

/**
 * Render the reviewable manifest for a projection (SPEC §8): a summary header
 * (counts per rule, the SPEC version, the gate verdict), the honest boundary
 * note, and one line per source file with its applied rule and, for a
 * shaped/redacted file, the before/after skeleton that survived. Pure: the same
 * result renders the same string.
 */
export function renderManifest(result: ProjectionResult): string {
  const { mode, entries, gate, specVersion, files } = result;
  const lines: string[] = [];

  lines.push(`icm-kit sanitize --mode ${mode} (SPEC ${specVersion})`);
  lines.push('');

  const byRule = countByRule(entries);
  lines.push('Summary:');
  const scope = mode === 'extract' ? 'in-scope file(s) (include set + routing chain)' : 'file(s) classified';
  lines.push(`  ${entries.length} ${scope}; ${files.length} emitted, ${
    entries.length - files.length
  } omitted.`);
  lines.push(`  pass_through: ${byRule.pass_through}   shape_only: ${byRule.shape_only}   redact_instance: ${byRule.redact_instance}`);
  lines.push(`  omit: ${byRule.omit}   omit_assert_absence (secret): ${byRule.omit_assert_absence}   unclassified: ${byRule.unclassified}`);
  lines.push('');

  // Extract mode names its scope explicitly (SPEC §8.5): the include set asked
  // for, and every routing CLAUDE.md the includes pulled in (shape-redacted), so
  // a reviewer sees exactly what the scope did and did not pull.
  if (mode === 'extract') {
    lines.push('Scope (extract):');
    lines.push('  --include:');
    for (const inc of result.includes ?? []) lines.push(`    ${inc === '' ? '. (whole workspace root)' : inc}`);
    lines.push(`  routing context pulled in (shape_only):${(result.routing ?? []).length === 0 ? ' none' : ''}`);
    for (const r of result.routing ?? []) lines.push(`    ${r}`);
    lines.push('');
  }

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

  lines.push(mode === 'extract' ? EXTRACT_BOUNDARY_NOTE : BOUNDARY_NOTE);
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
