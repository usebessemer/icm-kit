/**
 * Text analysis for `CLAUDE.md` and Markdown files.
 *
 * Every content heuristic the classifier (§2.5) and the audit runner (§3, §4)
 * rely on lives here, in one module, so the two cannot drift: load/skip-table
 * detection, file-pointer extraction (F3), section splitting and identity-shape
 * scoring (F5, F1 soft signal, W3), and stage-contract section parsing (W7/F6).
 *
 * These are deliberately lightweight heuristics. The load/skip-table format is
 * an open question (SPEC §5); identity-vs-situational shape is a marker-density
 * proxy, not semantic understanding. They are sized to the v0.1 rules and the
 * synthetic fixtures, and are the first place to revisit when tuning against a
 * real workspace.
 */

import { baseName } from './paths.js';

// ---------------------------------------------------------------------------
// Load/skip tables and per-file mentions (§2.3, §2.5)
// ---------------------------------------------------------------------------

/** A Markdown table row whose header names a Load or Skip column. */
const LOAD_SKIP_COLUMN = /^[ \t]*\|[^\n]*\b(load|skip)\b[^\n]*\|/im;
/** A heading announcing a load/skip (or routing) table. */
const LOAD_SKIP_HEADING = /^#{1,6}[ \t]+[^\n]*\b(load\s*\/\s*skip|routing)\b/im;

/** True if a CLAUDE.md carries a load/skip table (its `operations` content). */
export function hasLoadSkipTable(content: string): boolean {
  return LOAD_SKIP_COLUMN.test(content) || LOAD_SKIP_HEADING.test(content);
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
// Markdown file pointers (F3 STALE_CONTENT)
// ---------------------------------------------------------------------------

/**
 * A workspace-relative Markdown path token, e.g. `runbook.md` or
 * `references/voice.md`. The leading negative lookbehind keeps it from grabbing
 * the tail of a URL (`https://x/y.md`) or a longer identifier.
 */
const MD_POINTER = /(?<![\w:/.-])((?:[\w.-]+\/)*[\w.-]+\.md)/gi;

/** Every distinct Markdown path a CLAUDE.md points at, in first-seen order. */
export function extractMarkdownPointers(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(MD_POINTER)) {
    out.add(match[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Sections and identity shape (F5 LAYER_BLOAT, F1 soft signal, W3)
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

/** Behavioural / identity directive markers: the shape of `identity` content. */
const IDENTITY_MARKER =
  /\b(always|never|must|should|shouldn'?t|do not|don'?t|avoid|prefer|you are|your role|voice|tone|convention|style guide)\b/gi;

/** Count the behavioural directive markers in a block of text. */
export function countIdentityMarkers(text: string): number {
  return (text.match(IDENTITY_MARKER) ?? []).length;
}

/** True if a body has at least one non-blank line. */
export function hasContent(body: string): boolean {
  return body.split('\n').some((line) => line.trim().length > 0);
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
 * Check a stage-contract CONTEXT.md against the required `sections` (SPEC §2.6,
 * W7): each must appear as a heading with non-empty content.
 */
export function parseStageContract(
  content: string,
  sections: readonly string[],
): StageContractCheck {
  const found = splitSections(content);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const name of sections) {
    const section = found.find(
      (s) => s.heading.toLowerCase() === name.toLowerCase(),
    );
    if (!section) {
      missing.push(name);
    } else if (!hasContent(section.body)) {
      empty.push(name);
    }
  }
  return { missing, empty };
}
