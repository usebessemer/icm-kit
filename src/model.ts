/**
 * The ICM rule model.
 *
 * This module is the TypeScript encoding of SPEC.md (SPEC v0.8). It is the
 * single source both `init` and `audit` consume: the classification axes
 * (SPEC §2.2 to §2.4), the classification result shape (§2.5), the
 * well-formedness rules (§3), and the failure modes (§4).
 *
 * Per the project's spec-driven discipline, every value here traces to a
 * clause in SPEC.md. When the spec and this file disagree, the spec wins and
 * this file is the bug.
 */

// ---------------------------------------------------------------------------
// Classification axes (SPEC §2.2 to §2.4)
// ---------------------------------------------------------------------------

/**
 * Routing level: the vertical axis (SPEC §2.2). Levels are relative to the
 * workspace being audited; the audit-root `CLAUDE.md` defines the frame.
 *
 * - L0: the audit-root identity scope.
 * - L1: a nested workspace (any subdirectory with its own `CLAUDE.md`).
 * - L2: task-level routing inside a workspace (load/skip table or per-stage
 *   `CONTEXT.md`). L2 is content inside L1 or L0, not a separate location.
 */
export const ROUTING_LEVELS = ['L0', 'L1', 'L2'] as const;
export type RoutingLevel = (typeof ROUTING_LEVELS)[number];

/**
 * Content type: the type half of the horizontal axis (SPEC §2.3). Every
 * classified file holds exactly one of these four. `CLAUDE.md` is the sole
 * exception: it carries `identity` and may also carry `operations` content
 * (load/skip tables); see `MIXED_CONTENT_TYPES`.
 */
export const CONTENT_TYPES = [
  'identity',
  'situational',
  'reference',
  'working',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * The operations content type (SPEC §2.3, §2.6). Not a standalone file type:
 * it only ever co-occurs with `identity` inside a `CLAUDE.md` (load/skip
 * tables). Tracked separately so the classifier can report the mix that W3
 * and LAYER_BLOAT reason about.
 */
export const OPERATIONS_CONTENT = 'operations' as const;
export type OperationsContent = typeof OPERATIONS_CONTENT;

/**
 * Load pattern: the when half of the horizontal axis (SPEC §2.4). Every
 * classified file is read under exactly one pattern.
 *
 * - always: read on every session active at the file's routing level.
 * - on_demand: loaded when the current task matches a rule.
 * - per_item: loaded when the specific work item is the task target.
 */
export const LOAD_PATTERNS = ['always', 'on_demand', 'per_item'] as const;
export type LoadPattern = (typeof LOAD_PATTERNS)[number];

/**
 * The load pattern normally implied by a content type (SPEC §2.4). The
 * classifier reports content type and load pattern independently; a file
 * whose actual load pattern diverges from the implied one is a violation.
 * `operations` is excluded: it is not a standalone file and rides on the
 * containing `CLAUDE.md`'s `always` pattern.
 */
export const IMPLIED_LOAD_PATTERN: Record<ContentType, LoadPattern> = {
  identity: 'always',
  situational: 'always',
  reference: 'on_demand',
  working: 'per_item',
};

// ---------------------------------------------------------------------------
// Classification result (SPEC §2.5)
// ---------------------------------------------------------------------------

/**
 * The result of classifying one file path (SPEC §2.5):
 *
 *   classify(file_path, workspace_tree, claude_md_contents)
 *     -> { routing_level, content_type, load_pattern }
 *
 * A file that matches no rule in the default classification table is
 * `unclassified` (SPEC §2.5 final row): it has no routing path and is
 * reported as HIDDEN_CONTEXT (§4.2), so its axes are null.
 */
export interface Classification {
  /** Path relative to the nearest enclosing workspace root (SPEC §2.5). */
  readonly path: string;
  readonly routingLevel: RoutingLevel | null;
  readonly contentType: ContentType | null;
  readonly loadPattern: LoadPattern | null;
  /**
   * True only for `CLAUDE.md` carrying a load/skip table: it mixes `identity`
   * and `operations`, the one permitted mix (SPEC §2.3).
   */
  readonly carriesOperations: boolean;
  /** True when no classification-table row matched (SPEC §2.5, §4.2). */
  readonly unclassified: boolean;
  /** True for a stage-contract `CONTEXT.md` (SPEC §2.6): a reference subtype. */
  readonly stageContract: boolean;
}

// ---------------------------------------------------------------------------
// Well-formedness rules (SPEC §3)
// ---------------------------------------------------------------------------

/** Stable identifiers for the well-formedness rules (SPEC §3). */
export const WELL_FORMEDNESS_RULES = {
  W1: 'ROOT_IDENTITY',
  W2: 'SINGLE_ROOT_IDENTITY',
  W3: 'CONTENT_SEGREGATION',
  W4: 'NESTED_INTEGRITY',
  W5: 'ROUTABLE_FILES',
  W6: 'ROUTING_DEPTH',
  W7: 'STAGE_CONTRACT_SHAPE',
} as const;

export type WellFormednessId = keyof typeof WELL_FORMEDNESS_RULES;
export type WellFormednessCode =
  (typeof WELL_FORMEDNESS_RULES)[WellFormednessId];

// ---------------------------------------------------------------------------
// Failure modes (SPEC §4)
// ---------------------------------------------------------------------------

/**
 * Severity tiers. v0.1 emits only `warning`; `error` is reserved (SPEC §4,
 * §5). Encoded now so the type does not churn when tiers land.
 */
export const SEVERITIES = ['warning', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Stable identifiers for the failure-mode lint rules (SPEC §4).
 *
 * The codes are contiguous `F1` through `F9`, in section order (SPEC §4 intro).
 * `F7` (`KIT_BOILERPLATE`) is the first rule to consult git history. Each code
 * is bound to its rule by name, never by position.
 */
export const FAILURE_MODES = {
  F1: 'MONOLITHIC_CONTEXT',
  F2: 'HIDDEN_CONTEXT',
  F3: 'STALE_CONTENT',
  F4: 'OVER_ROUTING',
  F5: 'LAYER_BLOAT',
  F6: 'MALFORMED_STAGE_CONTRACT',
  F7: 'KIT_BOILERPLATE',
  F8: 'DUPLICATION',
  F9: 'SUPERSEDED_BUT_LIVE',
} as const;

export type FailureModeId = keyof typeof FAILURE_MODES;
export type FailureModeCode = (typeof FAILURE_MODES)[FailureModeId];

/**
 * A finding produced by an audit: one violated rule located at one path.
 * `rule` is a failure-mode or well-formedness code; `relatedRule` ties a
 * failure mode back to the well-formedness rule it enforces, where one exists
 * (e.g. OVER_ROUTING enforces W6).
 */
export interface Finding {
  readonly rule: FailureModeCode | WellFormednessCode;
  readonly severity: Severity;
  readonly path: string;
  readonly message: string;
  readonly relatedRule?: WellFormednessCode;
}

// ---------------------------------------------------------------------------
// Default thresholds (SPEC §4.1, §4.5, §4.4 / W6; §5 open question 3)
// ---------------------------------------------------------------------------

/**
 * Tunable thresholds. SPEC §5 (open question 3) flags these as educated
 * guesses tied to the paper's measurements; they are configurable in
 * principle (the config file format is not yet pinned, SPEC §5).
 */
export interface Thresholds {
  /** MONOLITHIC_CONTEXT hard signal for `CLAUDE.md`, in tokens (§4.1). */
  readonly claudeMdMaxTokens: number;
  /** MONOLITHIC_CONTEXT hard signal for any other single file (§4.1). */
  readonly fileMaxTokens: number;
  /** LAYER_BLOAT situational-prose-block size, in tokens (§4.5). */
  readonly layerBloatProseTokens: number;
  /** OVER_ROUTING / W6 maximum routing depth (§2.2, §4.4). */
  readonly maxRoutingDepth: number;
  /** DUPLICATION Jaccard floor for a duplicate block pair (§4.8). */
  readonly duplicationSimilarityFloor: number;
  /** DUPLICATION minimum block size to compare, in tokens (§4.8). */
  readonly duplicationMinBlockTokens: number;
  /** DUPLICATION word-shingle size for the Jaccard comparison (§4.8). */
  readonly duplicationShingleSize: number;
  /** SUPERSEDED_BUT_LIVE top-region scan depth, in lines (§4.9). */
  readonly supersededBannerScanLines: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  claudeMdMaxTokens: 4_000,
  fileMaxTokens: 8_000,
  layerBloatProseTokens: 500,
  maxRoutingDepth: 3,
  duplicationSimilarityFloor: 0.8,
  duplicationMinBlockTokens: 40,
  duplicationShingleSize: 5,
  supersededBannerScanLines: 15,
};

// ---------------------------------------------------------------------------
// Canonical homes and structural constants (SPEC §2.1, §2.3, §2.6)
// ---------------------------------------------------------------------------

/** The canonical root identity filename (SPEC §2.1). */
export const ROOT_IDENTITY_FILE = 'CLAUDE.md';

/** The stage-contract filename inside a numbered stage folder (SPEC §2.6). */
export const STAGE_CONTRACT_FILE = 'CONTEXT.md';

/** The skill-definition filename inside an auto-discovered skill (SPEC §2.5). */
export const SKILL_FILE = 'SKILL.md';

/** Matches a numbered stage folder, e.g. `01-discovery` (SPEC §2.6, W7). */
export const STAGE_FOLDER_PATTERN = /^\d{2,}-[A-Za-z0-9][\w-]*$/;

/**
 * Canonical home folders the classifier routes by location (SPEC §2.3, §2.5).
 *
 * `context` and `references` are the workspace homes. `memory` and `skill` are
 * Claude-Code harness homes at fixed paths (`.memory/` is always loaded; skills
 * are auto-discovered under `.claude/skills/`), routed as hard-coded defaults
 * because the harness puts them there on every install and no `CLAUDE.md` load
 * table declares them. Site-specific renamed homes are deferred (SPEC §5 q4).
 */
export const CANONICAL_HOMES = {
  situational: 'context',
  reference: 'references',
  memory: '.memory',
  skill: '.claude/skills',
} as const;

/** The four required stage-contract sections, in spec order (SPEC §2.6, W7). */
export const STAGE_CONTRACT_SECTIONS = [
  'Input',
  'Process',
  'Output',
  'Completion',
] as const;
export type StageContractSection = (typeof STAGE_CONTRACT_SECTIONS)[number];
