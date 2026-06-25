/**
 * Text analysis for `CLAUDE.md` and Markdown files.
 *
 * Every content heuristic the classifier (§2.5) and the audit runner (§3, §4)
 * rely on lives here, in one module, so the two cannot drift: load/skip-table
 * detection and pointer extraction (F3), identity-heading and density-based
 * behaviour-block detection (F5, F1 soft signal / W3), declared-work-folder
 * detection (§2.5 work-folder row), stage-contract section parsing (W7/F6),
 * cross-file prose-duplication segmentation and comparison (F8), and
 * superseded-banner detection in a file's top region (F9).
 *
 * These are deliberately coarse heuristics, hardened in #11 against the real-
 * AIOS failure shapes the synthetic fixture missed (directive-dense ops bloat,
 * situational prose with incidental directive words, prose-embedded paths). The
 * load/skip-table format and identity-vs-operations discrimination remain open
 * questions (SPEC §5); v0.1 accepts imperfection and documents it.
 */

import { baseName } from './paths.js';
import { STAGE_FOLDER_PATTERN } from './model.js';
import type { TokenCounter } from './tokens.js';

// ---------------------------------------------------------------------------
// Load/skip tables (§2.3, §2.5) and the pointers in them (F3)
// ---------------------------------------------------------------------------

/** A heading announcing a load/skip (or routing) table. */
const LOAD_SKIP_HEADING = /^#{1,6}[ \t]+[^\n]*\b(load\s*\/\s*skip|routing)\b/im;

/** True for a Markdown table row (a line fenced by pipes). */
function isTableRow(line: string): boolean {
  return /^[ \t]*\|.*\|[ \t]*$/.test(line);
}

/** True for a table separator row, e.g. `| --- | :--: |`. */
function isSeparatorRow(line: string): boolean {
  return /^[ \t]*\|[\s|:-]+\|[ \t]*$/.test(line);
}

/** True for a table header row that names both a Load and a Skip column. */
function isLoadSkipHeader(line: string): boolean {
  return isTableRow(line) && /\bload\b/i.test(line) && /\bskip\b/i.test(line);
}

/**
 * True if a CLAUDE.md carries a load/skip table (its `operations` content).
 * Tightened in #11 to require a header naming both Load and Skip, or a
 * load/skip heading, so an unrelated table with a lone "Load" column no longer
 * trips it.
 */
export function hasLoadSkipTable(content: string): boolean {
  if (LOAD_SKIP_HEADING.test(content)) return true;
  return content.split('\n').some(isLoadSkipHeader);
}

/** Index of the Skip cell in a header row split on `|`, or -1 if none. */
function skipColumnIndex(headerRow: string): number {
  return headerRow.split('|').findIndex((cell) => /\bskip\b/i.test(cell));
}

/** The data rows of the first load/skip table, with the header and separator dropped. */
function loadSkipTableRows(content: string): string[] {
  const lines = content.split('\n');
  const rows: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (!inTable) {
      if (isLoadSkipHeader(line)) inTable = true;
      continue;
    }
    if (!isTableRow(line)) break; // the table ended
    if (isSeparatorRow(line)) continue;
    rows.push(line);
  }
  return rows;
}

/**
 * A workspace-relative Markdown path token, e.g. `runbook.md` or
 * `references/voice.md`. The leading negative lookbehind keeps it from grabbing
 * the tail of a URL (`https://x/y.md`) or a longer identifier.
 */
const MD_POINTER = /(?<![\w:/.-])((?:[\w.-]+\/)*[\w.-]+\.md)/gi;

/** A directory path fragment ending in `/`, e.g. `references/kit/`. */
const DIR_TOKEN = /(?<![\w:/.-])((?:[\w.-]+\/)+)/g;

/** Basenames that recur as a per-folder convention rather than naming a file. */
const STRUCTURAL_NAMES: ReadonlySet<string> = new Set([
  'CONTEXT.md',
  'CLAUDE.md',
]);

/** A Markdown reference found in a load/skip table cell (F3). */
export interface LoadSkipReference {
  /** The `.md` token as written (bare like `_template.md`, or qualified). */
  readonly token: string;
  /**
   * True for a bare structural-convention basename (`CONTEXT.md`, `CLAUDE.md`)
   * with no qualifying directory: a generic placeholder, not a concrete pointer.
   */
  readonly structural: boolean;
  /** Workspace-relative paths to test for existence, in resolution order. */
  readonly candidates: string[];
}

/**
 * Markdown references in a CLAUDE.md's load/skip table (F3), resolved within
 * the cell they appear in.
 *
 * Scoped to the table rows (SPEC §4.3), not the whole document, so prose and
 * template paths do not produce findings. Within a cell, a bare name is also
 * resolved against any directory token in the same cell (a `dir/` + bare
 * `file.md` pair yields the candidate `dir/file.md`), and a bare structural
 * basename is flagged so the caller can treat it as a placeholder, not a
 * dangling pointer.
 */
export function extractLoadSkipReferences(content: string): LoadSkipReference[] {
  const refs: LoadSkipReference[] = [];
  for (const row of loadSkipTableRows(content)) {
    for (const cell of row.split('|')) {
      const tokens = [...cell.matchAll(MD_POINTER)].map((m) => m[1]);
      if (tokens.length === 0) continue;
      const dirs = [...cell.matchAll(DIR_TOKEN)].map((m) => m[1]);
      for (const token of tokens) {
        const bare = !token.includes('/');
        const candidates = [token];
        if (bare) {
          for (const dir of dirs) candidates.push(`${dir}${token}`);
        }
        const structural =
          bare && dirs.length === 0 && STRUCTURAL_NAMES.has(token);
        refs.push({ token, structural, candidates });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Markdown links (F2 reachability closure, §4.2)
// ---------------------------------------------------------------------------

/** An inline Markdown link's destination: the `dest` of every `](dest)`. */
const MD_LINK = /\]\(\s*([^)]+?)\s*\)/g;

/** A URI scheme prefix (`https:`, `mailto:`, etc.): an external, out-of-tree link. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The destinations of the inline Markdown links in `content` (F2 reachability,
 * SPEC §4.2), as raw path tokens for the caller to resolve and tree-test.
 *
 * Only real link syntax (`](dest)`) counts: a backtick filename in prose
 * (`` `foo.md` ``) is not a link and is never returned, mirroring how F3 scopes
 * to real load/skip references rather than prose mentions. Fenced code is
 * stripped first (as for §4.1/§4.8/§4.9), so a link shown inside a code example
 * does not route a file. Each destination is cleaned to a bare path: a CommonMark
 * `<...>` wrapper is removed, a `"title"` is dropped, and a `#fragment` is cut.
 * External destinations (a URI scheme such as `https:`) and pure `#anchor`
 * fragments are dropped: they resolve to nothing in-tree.
 */
export function extractMarkdownLinks(content: string): string[] {
  const targets: string[] = [];
  for (const match of stripFencedCode(content).matchAll(MD_LINK)) {
    let dest = match[1].trim();
    if (dest.startsWith('<')) {
      // A CommonMark angle-bracket destination runs to the closing `>` and may
      // hold spaces literally, so it is not split on whitespace.
      const close = dest.indexOf('>');
      dest = close === -1 ? dest.slice(1) : dest.slice(1, close);
    } else {
      // A bare destination ends at the first whitespace: a `path "title"` form.
      const space = dest.search(/\s/);
      if (space !== -1) dest = dest.slice(0, space);
    }
    const hash = dest.indexOf('#'); // a `path#fragment` form: keep the path
    if (hash !== -1) dest = dest.slice(0, hash);
    dest = dest.trim();
    if (dest === '' || URI_SCHEME.test(dest)) continue;
    targets.push(dest);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Declared work folders (§2.5 work-folder row)
// ---------------------------------------------------------------------------

/** A `name/` folder reference token. */
const FOLDER_TOKEN = /(?<![\w-])([A-Za-z0-9][\w-]*)\//g;

/**
 * Folder names the CLAUDE.md declares as work folders.
 *
 * Hardened in #11: a folder counts only where it is named outside the Skip
 * column (in prose or a non-skip table cell), so a folder that appears only as
 * a Skip target is not mistaken for a declared work folder. Canonical homes and
 * numbered stage folders are excluded.
 */
export function declaredWorkFolders(content: string): Set<string> {
  const lines = content.split('\n');
  const header = lines.find(isLoadSkipHeader);
  const skipCol = header ? skipColumnIndex(header) : -1;
  const folders = new Set<string>();
  for (const line of lines) {
    let scan = line;
    if (skipCol >= 0 && isTableRow(line) && !isSeparatorRow(line)) {
      const cells = line.split('|');
      if (skipCol < cells.length) cells[skipCol] = '';
      scan = cells.join('|');
    }
    for (const match of scan.matchAll(FOLDER_TOKEN)) folders.add(match[1]);
  }
  folders.delete('context');
  folders.delete('references');
  return new Set([...folders].filter((f) => !STAGE_FOLDER_PATTERN.test(f)));
}

/**
 * True when `claudeMd` names `relPath` explicitly: by its full relative path,
 * or by its basename in a path-like context (so `priorities.md` does not match
 * inside `old-priorities.md`).
 */
export function namedByClaudeMd(claudeMd: string, relPath: string): boolean {
  return (
    mentionsToken(claudeMd, relPath) || mentionsToken(claudeMd, baseName(relPath))
  );
}

/** True if `token` appears in `text` not preceded by a word or hyphen char. */
export function mentionsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRegExp(token)}`).test(text);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Sections, identity headings, and behaviour blocks (F5, F1 soft / W3)
// ---------------------------------------------------------------------------

/** One Markdown heading section (or the pre-heading preamble at level 0). */
export interface Section {
  /** Heading depth: 1 for `#`, 6 for `######`; 0 for the preamble. */
  readonly level: number;
  /** Heading text without the leading `#`s; '' for the preamble. */
  readonly heading: string;
  /** Body text after the heading, up to the next heading. */
  readonly body: string;
}

/** Split Markdown into heading sections, plus a level-0 preamble section. */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let level = 0;
  let heading = '';
  let body: string[] = [];
  const flush = (): void => {
    sections.push({ level, heading, body: body.join('\n') });
  };
  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (match) {
      flush();
      level = match[1].length;
      heading = match[2].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** A section heading that opens with an ISO date, after any leading marker. */
const DATED_ENTRY_HEADING = /^[\s*_>]*\d{4}-\d{2}-\d{2}\b/;

/** Minimum dated entries that make a file an append-only log (§4.1). */
const APPEND_ONLY_MIN_ENTRIES = 3;

/**
 * True when a file is an append-only log: an accreting ledger whose dominant
 * structure is a run of dated sibling entries (`## 2026-05-14 ...`,
 * `### 2026-06-10 · ...`), such as a decisions log or an async channel. Such
 * files grow by design, so F1 exempts them from the size cap (SPEC §4.1): the
 * hygiene is a tail-archive of old entries, not a split.
 *
 * Detected structurally and conservatively, so a large bloated file does not
 * slip the cap by carrying a few incidental dated headings:
 * - Fenced code is stripped first (as for F8/F9), so a documented log *format*
 *   in a code example does not count as real entries.
 * - A literal `YYYY-MM-DD` template placeholder is not a real date, so only
 *   actual dates count.
 * - The dated entries must dominate their level: at the modal heading level (the
 *   level carrying the most headings), the dated headings must be a strict
 *   majority and number at least `APPEND_ONLY_MIN_ENTRIES`. A ledger of all-`##`
 *   dated entries qualifies; a design doc with three dated `##` among twenty
 *   prose `##` does not.
 */
export function isAppendOnlyLog(content: string): boolean {
  const perLevel = new Map<number, { total: number; dated: number }>();
  for (const section of splitSections(stripFencedCode(content))) {
    if (section.level === 0) continue; // the preamble carries no heading
    const bucket = perLevel.get(section.level) ?? { total: 0, dated: 0 };
    bucket.total += 1;
    if (DATED_ENTRY_HEADING.test(section.heading)) bucket.dated += 1;
    perLevel.set(section.level, bucket);
  }
  let modal: { total: number; dated: number } | undefined;
  for (const bucket of perLevel.values()) {
    if (!modal || bucket.total > modal.total) modal = bucket;
  }
  if (modal === undefined) return false;
  return modal.dated >= APPEND_ONLY_MIN_ENTRIES && modal.dated * 2 > modal.total;
}

/** Headings that mark a section as recognisably `identity` content (§2.3). */
const IDENTITY_HEADING =
  /\b(identity|voice|tone|conventions?|persona|principles?|modes?|role|who (we|you) are|style guide|about (us|me|you))\b/i;

/**
 * True when a section heading reads as identity content. Coarse and heading-
 * based on purpose: marker density cannot tell legitimate directive-dense
 * identity (voice rules) from a directive-dense ops manual, so F5 keys off the
 * heading instead (SPEC §4.5, v0.1 limitation).
 */
export function isIdentityHeading(heading: string): boolean {
  return IDENTITY_HEADING.test(heading);
}

/** Behavioural / identity directive markers: the shape of `identity` content. */
const IDENTITY_MARKER =
  /\b(always|never|must|should|shouldn'?t|do not|don'?t|avoid|prefer|you are|your role|voice|tone|convention|style guide)\b/gi;

/** Count the behavioural directive markers in a block of text. */
export function countIdentityMarkers(text: string): number {
  return (text.match(IDENTITY_MARKER) ?? []).length;
}

const WORD = /\b[\w'-]+\b/g;

/** The minimum markers and density (markers per 100 words) of a behaviour block. */
const BEHAVIOUR_BLOCK_MIN_MARKERS = 3;
const BEHAVIOUR_BLOCK_MIN_DENSITY = 8;

/**
 * True when some section is a concentrated behaviour block: enough directive
 * markers, densely packed (F1 soft signal / W3).
 *
 * Density-normalised in #11 so a situational file that merely narrates
 * behaviour in passing ("the client always pays cash", brand "voice"/"tone"
 * notes) no longer trips the mixing check; only a real rules block does.
 */
export function hasBehaviourBlock(content: string): boolean {
  for (const section of splitSections(content)) {
    const markers = countIdentityMarkers(section.body);
    if (markers < BEHAVIOUR_BLOCK_MIN_MARKERS) continue;
    const words = (section.body.match(WORD) ?? []).length;
    const density = (markers * 100) / Math.max(1, words); // markers per 100 words
    if (density >= BEHAVIOUR_BLOCK_MIN_DENSITY) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage contracts (W7 / F6)
// ---------------------------------------------------------------------------

/** Which required stage-contract sections are absent or present-but-empty. */
export interface StageContractCheck {
  /** Required sections with no matching heading. */
  readonly missing: string[];
  /** Required sections present but with empty bodies. */
  readonly empty: string[];
}

/**
 * A trailing dash-qualifier on a heading: a spaced em-dash (U+2014) or en-dash
 * (U+2013) and everything after it. Built from `\u` escapes so the source
 * carries no literal em-dash (repo voice rule). A real stage heading often
 * qualifies the bare section name (a `## Process` heading followed by an em-dash
 * and a cadence note); the qualifier is annotation, not part of the section's
 * identity (§2.6).
 */
const HEADING_QUALIFIER = /\s+[\u2013\u2014]\s+.*$/;

/**
 * The bare section name of a heading: lowercased, with a trailing dash-qualifier
 * stripped, so a qualified `## Process` heading (an em-dash plus a repeat-cadence
 * note) normalizes to `process` and still satisfies `Process` (SPEC §2.6, §4.6).
 */
function normalizeHeading(heading: string): string {
  return heading.replace(HEADING_QUALIFIER, '').trim().toLowerCase();
}

/**
 * True if a heading names a required section, tolerating case, a trailing dash-
 * qualifier (a `## Process` heading with an em-dash note), and a trailing plural
 * (`## Inputs`).
 */
function headingMatches(heading: string, name: string): boolean {
  const h = normalizeHeading(heading);
  const n = name.toLowerCase();
  return h === n || h === `${n}s`;
}

/** True if a body has at least one non-blank line. */
export function hasContent(body: string): boolean {
  return body.split('\n').some((line) => line.trim().length > 0);
}

/**
 * Check a stage-contract CONTEXT.md against the required `sections` (SPEC §2.6,
 * W7): each must appear as a heading with non-empty content. Heading matching
 * is case-insensitive and tolerates a trailing plural (`## Inputs`).
 */
export function parseStageContract(
  content: string,
  sections: readonly string[],
): StageContractCheck {
  const found = splitSections(content);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const name of sections) {
    const section = found.find((s) => headingMatches(s.heading, name));
    if (!section) {
      missing.push(name);
    } else if (!hasContent(section.body)) {
      empty.push(name);
    }
  }
  return { missing, empty };
}

// ---------------------------------------------------------------------------
// Prose duplication (F8 DUPLICATION, §4.8)
// ---------------------------------------------------------------------------

/**
 * A line that is purely a Markdown link, a bare URL, or a single path/filename
 * token: structure, not substantive prose, so it is dropped from a block. A
 * mixed line (a path inside a sentence) is kept; only whole-line matches drop.
 */
function isLinkOrPathOnly(line: string): boolean {
  const stripped = line.replace(/^[-*+]\s+/, '').trim();
  if (stripped === '') return false;
  if (/^\[[^\]]*\]\([^)]*\)$/.test(stripped)) return true; // [text](url)
  if (/^<?https?:\/\/\S+>?$/.test(stripped)) return true; // bare URL
  if (/^`?[\w./-]+\.[A-Za-z0-9]{1,8}`?$/.test(stripped)) return true; // a path
  return false;
}

/**
 * A Markdown code-fence marker: the fence character (backtick or tilde) and its
 * run length, plus whether the line could *close* a fence (a closer carries no
 * info string, only trailing whitespace). `null` for a non-fence line. Up to
 * three leading spaces of indentation are allowed (CommonMark).
 */
function fenceMarker(
  line: string,
): { char: string; length: number; closeable: boolean } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return {
    char: match[1][0],
    length: match[1].length,
    closeable: match[2].trim() === '',
  };
}

/**
 * Remove fenced code blocks (``` / ~~~) from Markdown at the document level,
 * before any heading split, honouring CommonMark fence rules: a block opened by
 * a run of backticks or tildes closes only on a line of the *same* character
 * with a run *at least as long* and no info string. That is what keeps a
 * `#`-prefixed line inside a fence (a shell comment, a documented heading
 * example) from being read as a real heading, and keeps a mismatched or shorter
 * inner fence (a `~~~` inside a ```-block, or a ``` inside a ````-block, the
 * usual way docs show a fence verbatim) as code rather than a spurious closer.
 * Stripping fences first means `splitSections` never splits on one, so fenced
 * code can never desync section boundaries or leak into the comparison (F8). An
 * unclosed fence strips to end of document: its content is code, not prose.
 */
function stripFencedCode(content: string): string {
  const out: string[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of content.split('\n')) {
    const fence = fenceMarker(line);
    if (open === null) {
      if (fence) {
        open = { char: fence.char, length: fence.length };
        continue; // drop the opening fence line
      }
      out.push(line);
    } else if (
      fence &&
      fence.char === open.char &&
      fence.length >= open.length &&
      fence.closeable
    ) {
      open = null;
      continue; // drop the closing fence line
    }
    // Any other line while a fence is open (including a non-matching inner
    // fence) is code, and is dropped by falling through without a push.
  }
  return out.join('\n');
}

/**
 * The normalized words of one section body, for shingling (F8). Table rows,
 * blank lines, and link-/path-only lines are dropped; the rest is lowercased and
 * reduced to word tokens (Markdown punctuation falls away), so comparison is
 * over substance, not formatting. Fenced code is already gone (stripped at the
 * document level by `proseBlocks` before the heading split).
 */
function blockWords(body: string): string[] {
  const kept: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (isTableRow(raw)) continue;
    if (isLinkOrPathOnly(line)) continue;
    kept.push(line);
  }
  return kept.join(' ').toLowerCase().match(WORD) ?? [];
}

/**
 * Segment Markdown into normalized prose blocks for the DUPLICATION check
 * (F8, SPEC §4.8): one word list per heading section (the preamble included),
 * with fenced code stripped up front (so a `#` inside a fence is never read as a
 * heading), then tables and link-/path-only lines removed. Empty blocks are
 * dropped. Headings themselves are delimiters, never block content, so shared
 * short headings and stage-contract section labels never count as duplication.
 */
export function proseBlocks(content: string): string[][] {
  const blocks: string[][] = [];
  for (const section of splitSections(stripFencedCode(content))) {
    const words = blockWords(section.body);
    if (words.length > 0) blocks.push(words);
  }
  return blocks;
}

/** The set of contiguous `size`-word shingles in `words` (F8). */
function shingleSet(words: string[], size: number): Set<string> {
  const shingles = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) shingles.add(words.join(' '));
    return shingles;
  }
  for (let i = 0; i + size <= words.length; i += 1) {
    shingles.add(words.slice(i, i + size).join(' '));
  }
  return shingles;
}

/** Jaccard similarity of two shingle sets: |A ∩ B| / |A ∪ B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const shingle of small) if (large.has(shingle)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** One candidate file for the duplication comparison: a path and its text. */
export interface DuplicationInput {
  readonly path: string;
  readonly content: string;
}

/** Tunables for {@link findDuplicateProse} (the §4.8 thresholds, injected). */
export interface DuplicationOptions {
  /** Word-shingle size (`duplicationShingleSize`). */
  readonly shingleSize: number;
  /** Jaccard floor for a duplicate block pair (`duplicationSimilarityFloor`). */
  readonly similarityFloor: number;
  /** Minimum block size to compare, in tokens (`duplicationMinBlockTokens`). */
  readonly minBlockTokens: number;
  /** Token counter, the size signal for the block floor. */
  readonly countTokens: TokenCounter;
}

/** A pair of distinct files that share a duplicate prose block (F8). */
export interface DuplicatePair {
  readonly left: string;
  readonly right: string;
}

/**
 * The qualifying shingle sets of one file: blocks at or over the token floor.
 *
 * The floor measures the block's raw token count, while Jaccard runs over the
 * shingle *set*, so a heavily-repeated short line clears the floor on a small
 * set of unique shingles (SPEC §4.8). That is intentional for v0.6: repeated
 * boilerplate copied across routed homes is itself duplication worth flagging.
 * A unique-shingle minimum to discount pure repetition is deferred to calibration.
 */
function qualifyingShingleSets(
  content: string,
  opts: DuplicationOptions,
): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const words of proseBlocks(content)) {
    if (opts.countTokens(words.join(' ')) < opts.minBlockTokens) continue;
    const shingles = shingleSet(words, opts.shingleSize);
    if (shingles.size > 0) sets.push(shingles);
  }
  return sets;
}

/**
 * Find every pair of distinct files sharing a duplicate prose block (F8, SPEC
 * §4.8). Each file is segmented into normalized blocks; blocks below the token
 * floor are dropped; the surviving blocks are compared pairwise across files by
 * Jaccard over word shingles. A file pair is returned once if any block pair
 * meets the floor, with `left`/`right` in input order (so a path-sorted input
 * yields deterministic, lexically-ordered pairs).
 */
export function findDuplicateProse(
  files: readonly DuplicationInput[],
  opts: DuplicationOptions,
): DuplicatePair[] {
  const indexed = files.map((file) => ({
    path: file.path,
    blocks: qualifyingShingleSets(file.content, opts),
  }));
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < indexed.length; i += 1) {
    for (let j = i + 1; j < indexed.length; j += 1) {
      if (blocksOverlap(indexed[i].blocks, indexed[j].blocks, opts.similarityFloor)) {
        pairs.push({ left: indexed[i].path, right: indexed[j].path });
      }
    }
  }
  return pairs;
}

/** True if any block of `a` is at or above the floor against any block of `b`. */
function blocksOverlap(
  a: Set<string>[],
  b: Set<string>[],
  floor: number,
): boolean {
  for (const blockA of a) {
    for (const blockB of b) {
      if (jaccard(blockA, blockB) >= floor) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Superseded banners (F9 SUPERSEDED_BUT_LIVE, §4.9)
// ---------------------------------------------------------------------------

/**
 * Phrase markers that are self-complete: a top-region line opening with one is a
 * banner even bare, because the phrase typically precedes a target path
 * (`Replaced by build-c.md`). Matched with `startsWith` (a trailing `\b`).
 */
const SUPERSEDED_PHRASE_MARKERS = ['replaced by', 'no longer current'];

/**
 * Single-word markers that also occur as ordinary prose openers (`# Deprecated
 * features`, `Do not use tabs`). To avoid that false-positive class they fire
 * only when *label-shaped* (see `WORD_BANNER`): the marker is the whole line, or
 * is followed by a separator / closing emphasis / `by` / `as`.
 */
const SUPERSEDED_WORD_MARKERS = [
  'superseded',
  'deprecated',
  'reframed',
  'retired',
  'obsolete',
  'do not use',
];

/**
 * Every status marker F9 recognises (SPEC §4.9), the union of the phrase and
 * word groups above. `archived` is deliberately omitted: it overlaps the
 * `archives/` guard and a self-labelled "archived" file in a live home is the
 * very thing F9 reports, so matching the word would muddy the message.
 */
export const SUPERSEDED_MARKERS: readonly string[] = [
  ...SUPERSEDED_WORD_MARKERS,
  ...SUPERSEDED_PHRASE_MARKERS,
];

/**
 * Leading blockquote / emphasis / heading / bracket punctuation to strip, plus a
 * leading emoji / variation-selector run so a banner prefixed with a warning
 * glyph (`> **⚠️ REFRAMED ...`) still reaches the marker test. Emoji are matched
 * via `\p{Extended_Pictographic}` (the `⚠` code point) and the variation
 * selectors `U+FE00-FE0F` (the `️` that follows it); the `u` flag enables both.
 */
const BANNER_PUNCTUATION = new RegExp('^[\\s>*_#`(\\p{Extended_Pictographic}\\uFE00-\\uFE0F]+', 'u');

/** A self-complete phrase marker at line start. */
const PHRASE_BANNER = new RegExp(`^(?:${SUPERSEDED_PHRASE_MARKERS.join('|')})\\b`);

/**
 * A single-word marker at line start that is label-shaped: it ends the line, or
 * is followed by a separator (`:.,;!?`, a closing bracket), a closing emphasis
 * mark (`*_~` or a backtick, directly attached), a label-terminated ISO date, or
 * ` by`/` as`. The date case covers the `SUPERSEDED 2026-06-01 by ...` /
 * `REFRAMED 2026-06-03 (see ...)` banner shape, where a date follows the marker
 * before any separator. The date must itself be label-terminated (line-end, a
 * separator / bracket / em-dash `U+2014`, a closing emphasis mark, or ` by`/
 * ` as`): a `marker + date` that runs on into a verb (`Deprecated 2024-01-15 was
 * the original ship date`) is prose, not a banner, so the post-date anchor keeps
 * it silent. An opening `(` counts as label-termination because a parenthetical
 * annotates rather than continues the sentence (the `(see ...)` citation form).
 */
const WORD_BANNER = new RegExp(
  '^(?:' +
    SUPERSEDED_WORD_MARKERS.join('|') +
    ')(?=$|\\s*[:.,;!?)\\]]|[*_`~]|' +
    '\\s+\\d{4}-\\d{2}-\\d{2}(?=$|\\s*[:.,;!?)(\\u2014\\]]|\\s*[*_`~]|\\s+(?:by|as)\\b)|' +
    '\\s+(?:by|as)\\b)',
);

/** A `status:` line whose value is a dead-status marker. */
const STATUS_BANNER = /^status\s*:\s*(?:superseded|deprecated|retired)\b/;

/**
 * True when a line is a banner: after stripping leading blockquote/emphasis/
 * heading/bracket punctuation, lowercasing, and collapsing whitespace, it begins
 * with a status marker (SPEC §4.9). Line-start matching keeps a mid-line mention
 * ("the v1 pipeline was deprecated") from tripping; the label-shape requirement
 * on single-word markers further keeps a live opener ("# Deprecated features")
 * from tripping, while bare/labelled banners ("Deprecated.", "Superseded by X")
 * still match.
 */
function isBannerLine(line: string): boolean {
  const text = line.replace(BANNER_PUNCTUATION, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return PHRASE_BANNER.test(text) || WORD_BANNER.test(text) || STATUS_BANNER.test(text);
}

/**
 * True when a file carries a superseded/deprecated banner in its top region
 * (F9, SPEC §4.9): the preamble plus the first heading section, capped at
 * `scanLines` lines. Scoped to the top so a deprecation mentioned deep in the
 * body, or a `## Deprecated changes` heading in a later section, does not trip
 * it; matched at line start so a mid-line mention does not either. Fenced code
 * is stripped first (as for F8, §4.8), so a marker word inside a code example
 * does not count as a banner.
 */
export function hasSupersededBanner(content: string, scanLines: number): boolean {
  const sections = splitSections(stripFencedCode(content));
  // An empty preamble (a heading-first file) contributes no lines, not a
  // phantom '' from `''.split('\n')`, so heading-first and prose-first files get
  // the same `scanLines` budget.
  const region: string[] = sections[0].body === '' ? [] : sections[0].body.split('\n');
  if (sections.length > 1) {
    const first = sections[1];
    region.push(`${'#'.repeat(first.level)} ${first.heading}`, ...first.body.split('\n'));
  }
  return region.slice(0, scanLines).some(isBannerLine);
}
