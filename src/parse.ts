/**
 * Text analysis for `CLAUDE.md` and Markdown files.
 *
 * Every content heuristic the classifier (§2.5) and the audit runner (§3, §4)
 * rely on lives here, in one module, so the two cannot drift: load/skip-table
 * detection and pointer extraction (F3), identity-heading and density-based
 * behaviour-block detection (F5, F1 soft signal / W3), declared-work-folder
 * detection (§2.5 work-folder row), and stage-contract section parsing (W7/F6).
 *
 * These are deliberately coarse heuristics, hardened in #11 against the real-
 * AIOS failure shapes the synthetic fixture missed (directive-dense ops bloat,
 * situational prose with incidental directive words, prose-embedded paths). The
 * load/skip-table format and identity-vs-operations discrimination remain open
 * questions (SPEC §5); v0.1 accepts imperfection and documents it.
 */

import { baseName } from './paths.js';
import { STAGE_FOLDER_PATTERN } from './model.js';

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

/** True if a heading names a required section, tolerating case and a plural. */
function headingMatches(heading: string, name: string): boolean {
  const h = heading.toLowerCase();
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
