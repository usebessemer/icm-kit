# ICM Spec: v1.0

This document is the machine-checkable encoding of the architecture described in *Context as Architecture* (usebessemer/research, 2026-05-29). It is the shared contract between the two tools in `icm-kit`: `init`, which generates structures that satisfy the spec, and `audit`, which checks structures against it.

The spec is language-agnostic. Any implementation should produce equivalent classifications and findings for the same workspace.

---

## 1. Purpose and scope

The spec defines, in precise terms:

- How every file in a workspace is **classified** by routing level, content type, and load pattern.
- The **well-formedness rules** an ICM-compliant workspace must satisfy.
- The **failure modes** an audit reports when those rules are violated.

The spec does **not** prescribe:

- An implementation language for `init` or `audit`.
- File-content conventions beyond what is needed to classify files (heading style, prose voice, citation discipline).
- A registry of task types or specific load/skip table contents.
- Storage layout, output format, or CLI surface for the tools.

Where the source paper allows interpretation, the spec picks one precise answer for v0.1 and labels the choice as such. Genuine open questions are listed in §5.

---

## 2. The model

### 2.1 Workspace and unit of classification

A **workspace** is the directory rooted at a `CLAUDE.md` file. The workspace contains everything beneath that root, except the contents of nested workspaces (which are their own units).

The **unit of classification** is a single file path within a workspace. Folders are not classified directly; their role is inferred from the files they contain and from the routing rules in the enclosing workspace's `CLAUDE.md`.

For v0.1 the spec recognises `CLAUDE.md` as the canonical root identity file. Vendor variants (`AGENTS.md`, etc.) play the same role conceptually but are deferred to v0.2 (see §5).

### 2.2 Routing levels (vertical axis)

Routing levels are **relative to the workspace being audited**. The root `CLAUDE.md` of that workspace defines the audit frame.

- **L0**: the audit-root identity scope. The root `CLAUDE.md` and the workspace's top-level always-loaded files.
- **L1**: a nested workspace. Any subdirectory containing its own `CLAUDE.md` introduces an L1 scope inside its parent. L1 nests fractally: an L1 workspace may itself contain L1 workspaces.
- **L2**: task-level routing **inside** any workspace. Expressed either as a load/skip table inside that workspace's `CLAUDE.md`, or as per-stage `CONTEXT.md` files in a multi-stage pipeline. L2 is content inside L1 (or L0), not a separate file location.

**Routing depth** is the count of `CLAUDE.md` files in a file's lineage from the audit root to the deepest `CLAUDE.md` whose workspace contains it. The audit root itself counts as depth 1. A file in a nested workspace inside that root has depth 2. Depth above 3 triggers the over-routing failure mode (§4.4).

**Audit-frame reporting.** Routing level is always reported relative to the workspace being audited (the audit frame), not relative to a file's own workspace. A nested workspace's `CLAUDE.md` is L0 *of its own workspace* yet is reported as **L1** when audited from an enclosing root; its contents are reported at L1 as well (or L2 for a stage contract). This resolves the apparent tension in the §2.5 table between "L0 of its workspace" (the `CLAUDE.md` row) and "L1 (from parent)" (the nested-subdirectory row): both describe the same nested `CLAUDE.md`, and the audit reports the latter. In frame terms, depth 1 is L0 and any deeper nesting is L1.

### 2.3 Content types (horizontal axis, type half)

Every classified file holds exactly one of four content types:

- **identity**: who the agent is at this scope. Conventions, voice rules, behavioural patterns, mode declarations. Declarative and durable. Canonical home: `CLAUDE.md`.
- **situational**: always-relevant facts about the user or project that are not identity statements. Active state. Canonical homes: `context/`, and the harness agent-memory store `.memory/` (always loaded, never declared in a load table).
- **reference**: durable, cross-cutting knowledge loaded on demand by task type. Canonical homes: `references/`, and auto-discovered skills at `.claude/skills/<slug>/SKILL.md`.
- **working**: per-task work products created and consumed during execution. Canonical home: a work folder (`projects/`, `chapters/`, `clients/`, numbered engagement stages, etc.), including the non-`CONTEXT.md` files of a numbered stage folder.

The `.memory/` and `.claude/skills/` homes are Claude-Code harness conventions at fixed paths, recognised as hard-coded defaults because the harness places them identically on every install and no `CLAUDE.md` load table declares them. Site-specific renamed homes are out of scope for v0.2 (§5 open question 4).

**Stage contracts** are a subtype of `reference` with a specific four-section shape. They live at L2 and are specified in detail in §2.6.

`CLAUDE.md` is the only file permitted to mix content types: it carries `identity` and, at workspace level, `operations` content (load/skip tables). All other files are single-type.

### 2.4 Load patterns (horizontal axis, when half)

Every classified file is read into the context window under exactly one of three patterns:

- **always**: read on every session active at the file's routing level. Used by `identity` and `situational`.
- **on_demand**: loaded when the current task matches a rule (either by canonical location or by a load/skip table entry). Used by `reference` (including stage contracts).
- **per_item**: loaded when the specific work item is the target of the current task. Used by `working`.

Load pattern is normally implied by content type, but the classifier reports both attributes independently. A mismatch (e.g., a file labelled `identity` stored under `projects/`) is a violation.

### 2.5 Classification function

The classifier is a pure function:

```
classify(file_path, workspace_tree, claude_md_contents)
  -> { routing_level, content_type, load_pattern }
```

Inputs:

- `file_path`: path relative to the nearest enclosing workspace root.
- `workspace_tree`: the set of all files in the workspace, used to detect nested workspaces and unclassified files.
- `claude_md_contents`: the text of `CLAUDE.md` files in the lineage, used to parse load/skip tables and per-file references.

Default classification table (matched in order; first match wins):

| Path pattern (relative to enclosing workspace root) | content_type | load_pattern | routing_level |
|---|---|---|---|
| `CLAUDE.md` | identity (+ operations if a load/skip table is present) | always | L0 of its workspace (L1 when nested; reported in the audit frame, §2.2) |
| `context/**/*.md` | situational | always | scope of enclosing workspace |
| `.memory/**/*.md` | situational | always | scope of enclosing workspace |
| `references/**/*.md` | reference | on_demand | scope of enclosing workspace |
| `.claude/skills/<slug>/SKILL.md` | reference | on_demand | scope of enclosing workspace |
| Numbered stage folder, e.g. `NN-name/CONTEXT.md` | reference (stage contract) | on_demand | L2 |
| `NN-name/**/*.md` other than the stage `CONTEXT.md` (a stage working file, anywhere under the stage folder including a subfolder) | working | per_item | L2 |
| Any `*.md` under a folder mentioned in the enclosing `CLAUDE.md` as a work folder | working | per_item | scope of enclosing workspace |
| Subdirectory containing its own `CLAUDE.md` | introduces an L1 workspace; classify its contents recursively in that workspace's frame | n/a | L1 (from parent) |
| Any other `*.md` not matched above | unclassified → reported as Hidden context (§4.2) | n/a | n/a |

Files referenced explicitly by a `CLAUDE.md`'s load/skip table are routed by that reference. In v0.1 this acts as a **fallback**, evaluated after the default-table rows above: a load/skip mention rescues a file that no default row matched (it routes `on_demand` as a `reference`, satisfying W5), but it does **not** override the classification of a file already matched by its canonical home (rows 1 to 5 take precedence). Full **type-precedence**, where a table entry reclassifies a canonical-home file as `reference` or `working` per an explicit per-file load rule, requires parsing the load/skip table's per-file type assignments, whose format is not yet pinned (§5); it is deferred to v0.2. Until then, a canonical-home match wins.

Routing is also **transitive through references** (v0.12). The classifier above decides one file in isolation, but routability (W5, §4.2) is a property of the whole workspace: a file is routed if it is reachable from a canonical home through a chain of resolved references in already-routed files. A thin pointer or index file, itself routed (named in a load/skip table, or living in a canonical home), can carry the routing of the files it links: the targets of its Markdown links are routed even when no `CLAUDE.md` names them directly. The reachable set is the closure of today's per-file routing (the seed) under two reference kinds, each resolved relative to the **referencing** file's directory and kept only when it lands on an in-tree Markdown file: the Markdown links (`](path)`) of any routed file, and the load/skip-table cells of a routed `CLAUDE.md`. Prose mentions and backtick filenames are not references (only a real link or table cell is), the closure expands only through files already routed (an orphan cannot route another orphan), and a dead, external, or `#anchor` link resolves to nothing. This per-file classifier still reports each file's type in isolation; the transitive pass governs only whether a file is hidden (§4.2), not its content type.

### 2.6 Stage contracts

A stage contract is the formal interface for one stage of a multi-stage workflow. It is written as a `CONTEXT.md` file inside a numbered stage folder (matching the pattern `NN-name/CONTEXT.md`, e.g. `01-discovery/CONTEXT.md`).

Every stage contract has four required sections, in any order:

- **Input.** What this stage consumes. Specific file paths, often outputs of prior stages; references loaded on-demand for this stage's task type; any free-form input such as a brief or directive.
- **Process.** What the stage does to the input. A sequence of operations, decisions, or transformations. Typically three to seven steps. Operational guidance, not implementation prescription.
- **Output.** What the stage produces. Specific artifacts at specific paths. Both content and location are specified, because the next stage's Input names them.
- **Completion.** When the stage is *done*. The acceptance criteria under which the stage is finished, not merely terminated. Examples: all named output files exist and validate against a schema; a human reviewer has tagged the stage complete; all open questions are either resolved or moved to a designated log.

Completion is the field that distinguishes a stage that *terminates* (the agent stops) from one that *completes* (the work is genuinely finished). Without an explicit Completion clause, that gap becomes invisible until it bites.

The four sections are required for a stage contract to be well-formed. Their absence or emptiness is a violation; see W7 and F6.

Stage contracts are the mature form of L2 task routing for multi-stage pipelines. The simpler form, a load/skip table inside a workspace's `CLAUDE.md`, suffices for workspaces with few task types and short per-task instructions.

---

## 3. Well-formedness rules

A workspace is **ICM-compliant** if and only if all the following hold. Each rule has an identifier used in audit output.

- **W1 (`ROOT_IDENTITY`).** A `CLAUDE.md` exists at the workspace root.
- **W2 (`SINGLE_ROOT_IDENTITY`).** Exactly one `CLAUDE.md` exists at the workspace root (no duplicates from case variations, no competing root identity files).
- **W3 (`CONTENT_SEGREGATION`).** Each non-`CLAUDE.md` file holds a single content type, and lives in the canonical home for that content type (or in an alternative location explicitly mapped by the enclosing `CLAUDE.md`).
- **W4 (`NESTED_INTEGRITY`).** Every directory containing a `CLAUDE.md` constitutes a workspace boundary, and W1-W3 hold for that nested workspace.
- **W5 (`ROUTABLE_FILES`).** Every file in the workspace is reachable through a routing path: either its canonical location implies its load rule, the enclosing workspace's `CLAUDE.md` mentions it by name or pattern, or it is referenced (transitively) by an already-routed file, such as a routed pointer or index file that links it (§2.5, §4.2).
- **W6 (`ROUTING_DEPTH`).** Workspace routing depth (per §2.2) is at most 3.
- **W7 (`STAGE_CONTRACT_SHAPE`).** Every `CONTEXT.md` file located in a numbered stage folder (pattern `NN-name/CONTEXT.md`) contains all four required section headings (`## Input`, `## Process`, `## Output`, `## Completion`; matched case-insensitively, tolerating a trailing plural and a trailing dash-qualifier: a spaced em-dash (U+2014) or en-dash (U+2013) and any text after it are stripped before the match, so a `## Process` heading annotated with a repeat cadence still satisfies `Process`), and each section has non-empty content.

---

## 4. Failure modes

Each failure mode is a lint rule, carrying a stable code (`F1` through `F9`, in section order 4.1 through 4.9) that the rule model and audit output use as its identifier. The first five (`F1` to `F5`) are derived directly from the paper's Failure Modes section. The remaining four are original to icm-kit and have no counterpart in the paper: `F6` (`MALFORMED_STAGE_CONTRACT`, §4.6) enforces the stage-contract shape required by W7 (§3); `F7` (`KIT_BOILERPLATE`, §4.7) is the first rule to consult git history, flagging a file inherited from the workspace's fork point and never adapted since; `F8` (`DUPLICATION`, §4.8) and `F9` (`SUPERSEDED_BUT_LIVE`, §4.9) are a whole-workspace and a per-file content check respectively. Each code is bound to its rule by name and section order, never by merge order, so the codes are contiguous. Severity in v0.1 is `warning` for all rules; an `error` severity is reserved for later.

### 4.1 `MONOLITHIC_CONTEXT`

A single file at any routing level grown so large or so mixed in content that it dominates the context window or violates content-type segregation.

**Detection (v0.1):**
- Hard signal: file size exceeds a threshold. Defaults: `CLAUDE.md` over 4,000 tokens; any other single file over 8,000 tokens. Token counts use tiktoken `cl100k_base` (wired via `js-tiktoken`) as a proxy for Claude's tokenizer (see paper appendix). The size check applies to UTF-8 **text** only: a binary or non-text file (detected by a NUL byte in its head at read time) is not token-counted or size-checked, because a byte count is not a meaningful token estimate for a binary format. Thresholds are configurable and stay at the defaults: a crude guard for egregiously large files, deliberately not tuned to reproduce any one hand-audit (see §5 open question 3). An **append-only log is exempt from the hard signal (v0.11):** an accreting ledger whose dominant structure is a run of dated entries (a decisions log, an async channel) grows by design, so a size finding would be a false positive. Detection is structural and conservative, so a large bloated file cannot slip the cap by carrying a few incidental dated headings. Fenced code is stripped first (as for §4.8 and §4.9), so a documented log *format* in a code example does not count. A literal `YYYY-MM-DD` template placeholder is not a real date. The dated entries must **dominate their own heading level**: at the modal heading level (the level carrying the most headings), the headings that open with an ISO date (`## 2026-05-14 ...`, `### 2026-06-10 · ...`) must be a strict majority and number at least three. So a ledger of all-`##` dated entries qualifies, while a design doc with three dated `##` among twenty prose `##`, or three dated `###` beneath a `##`-dominated outline, does not. The remedy for a qualifying file is a tail-archive of old entries, not a split, so it is not flagged. The exemption never applies to a `CLAUDE.md`: the L0 identity cap holds even when the file carries dated headings.
- Soft signal: a single file (other than a `CLAUDE.md`, the only file permitted to mix identity and operations) contains content of more than one content type. v0.1 detects the common case: a non-identity file carrying a dense, contiguous block of behavioural directives. Detection is density-normalised, so a situational fact that merely narrates behaviour ("the client always pays cash") does not trip it; only a genuine rules block does. A **transient leaf work file is exempt (v0.13):** a per-item `working` product (a numbered-stage work file or a declared-work-folder deliverable) is loaded only when its own work item is the task, never always-loaded and not an inherited contract, so a behaviour block intrinsic to the deliverable (a scripted call agenda, scripted lines, a `Tone`/`Don't` list) is the work, not a content-type mix. An always-loaded standing file (`identity`, `situational`) or an on-demand `reference` that embeds a behaviour block still fires.

**Severity:** warning.

### 4.2 `HIDDEN_CONTEXT`

A file that exists in the workspace tree but has no routing path. The agent will never read it under any task rule.

**Detection:** any `*.md` file outside the workspace's **routing reachability closure** (v0.12). The closure is computed once over the whole workspace: it is seeded with every file the per-file classifier already routes (canonical and harness homes, stage and work files, and files a `CLAUDE.md` names), then expanded to a fixpoint by following references out of each already-routed file: the Markdown links (`](path)`) of any routed file, and the load/skip-table cells of a routed `CLAUDE.md`, each resolved relative to the referencing file's own directory and kept only when it lands on an in-tree Markdown file. A file the closure does not reach is hidden. This subsumes the prior local rule (not matched by the table and not named by the enclosing `CLAUDE.md`) and additionally routes a file reached only through a routed pointer file's links, so a pointer-indexed file is no longer mis-flagged. The over-broadening guards: only real references count (a prose mention or a backtick filename is not a reference, fenced-code links are stripped); the closure expands only through files already routed (an orphan cannot route another orphan); and a dead, external, or `#anchor` link resolves to nothing and routes no phantom file. Excludes the audit tool's own metadata files (deferred to v0.2 once those exist).

**Severity:** warning.

### 4.3 `STALE_CONTENT`

Loaded content that no longer reflects current truth: load/skip tables out of sync with the file tree, references to retired conventions, situational facts marked as active that are no longer accurate.

**Detection (v0.1 partial):**
- The load/skip table references a file that does not exist. Pointers are read from the load/skip table rows only, not from prose, so template paths (`YYYY-MM-DD.md`) and cross-repo example paths mentioned in prose do not produce spurious findings. Within a cell, a pointer is resolved before it is judged missing: a bare filename is also tested against any directory token in the same cell (a `dir/` plus a bare `file.md` resolves to `dir/file.md`), and a bare structural-convention basename (`CONTEXT.md`, `CLAUDE.md`) with no qualifying directory is treated as a per-folder placeholder, not a concrete pointer. Each candidate is resolved relative to the directory of the CLAUDE.md it appears in, with `.` and `..` segments collapsed, so a relative pointer from a nested CLAUDE.md (a cross-altitude `../../context/training.md` or a sibling-workspace `../coaching/ref.md`) is tested against the file tree's normalized paths, not against its literal `..` segments. A concrete pointer that still resolves to nothing is flagged once per stale pointer: the same missing token repeated across several load/skip cells in one CLAUDE.md yields a single finding, not one per cell.
- Load/skip table omits a file present in a canonical work folder (deferred: needs the load/skip-table format pinned, §5).
- Time-based heuristics (file age, last-modified vs git activity) are deferred to v0.2.

**Severity:** warning.

### 4.4 `OVER_ROUTING`

Workspace routing depth exceeds the threshold in W6.

**Detection:** any file at a routing depth greater than 3.

**Severity:** warning.

### 4.5 `LAYER_BLOAT`

Content at the wrong routing level. The most common variants:

- Operations content (load/skip tables, task-specific instructions) in the root `CLAUDE.md` when the tasks operate inside a child workspace.
- Long-form situational facts baked into a `CLAUDE.md` instead of split out to `context/`.

**Detection (v0.1):**
- Root `CLAUDE.md`'s load/skip table routes a task at a file that lives only inside a child workspace.
- `CLAUDE.md` contains a section above a configurable size threshold (default: 500 tokens) that is neither the permitted load/skip table (§2.3) nor recognisably identity content. This covers both misplaced operations prose (per-tool ops manuals) and long-form situational facts that belong in `context/` or a child workspace. v0.1 recognises identity by heading shape, **not** marker density: real ops manuals are directive-dense (`must`/`never`/`always`), so a density filter would invert and wrongly exempt them, while keying off size plus a non-identity heading catches them. The heuristic is coarse and heading-dependent, and the identity preamble is exempt (F1 backstops a headingless monolith); refining the identity-vs-operations signal is deferred (§5).

**Identity by heading shape (v0.14).** Beyond the `IDENTITY_HEADING` keyword vocabulary, the identity discrimination also recognises lead-contract / operating-model headings: `operating model`, `compartmentalisation` (either spelling), and the `what this ... is` self-definition shape. A root's operating model, its scope-boundary, and its self-definition **are** the root's identity, so an oversized block under one of them is contract prose, not layer bloat. The match is anchored to the **normalized whole heading** (per §4.6: a leading enumerator, one trailing parenthetical, and a trailing dash-qualifier are stripped first), **not** a substring: a situational heading that merely reuses a contract word (`## Operating model in practice`, `## Out of scope this sprint`, `### Lead (current) status`) is shape-distinct and still fires when oversized. An optional leading altitude token (`L0 `) is admitted. Further refinement (catching small misplaced ops stubs that restate a dedicated routed file, below the size cap) is deferred (§5).

**Severity:** warning.

### 4.6 `MALFORMED_STAGE_CONTRACT`

A stage contract `CONTEXT.md` missing one or more of the required IPO + C sections, or with an empty section.

**Detection:** Parse headings; verify all four sections (`## Input`, `## Process`, `## Output`, `## Completion`) are present, and each has at least one non-empty line of content beneath it. Heading matching is case-insensitive, normalized, and tolerates a trailing plural (`## Inputs` satisfies `Input`). **A trailing dash-qualifier is stripped before the comparison (v0.13):** a spaced em-dash (U+2014) or en-dash (U+2013) and everything after it is an annotation, not part of the section's identity, so a `## Process` heading qualified with a repeat cadence (`repeats at 1mo / 3mo / 6mo`) after the dash still satisfies `Process`. A `CONTEXT.md` genuinely missing a section (no heading normalizes to it) still fires.

**Severity:** warning.

### 4.7 `KIT_BOILERPLATE`

A file inherited from the workspace's fork or import point and never adapted since: its git history shows no commit after the configured fork-point commit, so its content is upstream boilerplate the workspace never made its own.

**Detection (v0.8):** Requires git history (the first rule to use it; the broader time-based `STALE_CONTENT` heuristics of §4.3 stay deferred). A configurable fork-point commit identifies the boundary (default: the repository's root commit; overridable via `--fork-point <ref>`). A tracked file is flagged when it existed at the fork-point commit and no commit after it has touched its path. Scoped to classified, routable text files: `CLAUDE.md` is exempt (identity starts from a template; F1/F5/W-rules govern it), binaries and unreadable files are exempt (§4.1), unrouted files are reported as Hidden context (§4.2) not boilerplate, and the harness and work homes where "untouched since the fork" is the expected state, not a defect, are exempt even when routed: the always-loaded `.memory/` store and numbered-stage work files (§2.5), alongside retired `archives/` content. Auto-discovered skills are not exempt: an un-adapted kit skill is exactly the boilerplate this rule targets. A workspace not under git, or a shallow clone lacking the fork-point commit, produces no findings; a wrong or missing fork-point degrades to under-reporting, never to spurious findings.

**Severity:** warning.

### 4.8 `DUPLICATION`

The same substantive prose lives in two separately-routed homes (e.g. root identity restating a `context/` or `references/` file; a scope-discipline file restating an engagement-scope file).

**Detection (v0.6):** for each pair of distinct classified text files, both routed (not `unclassified`), segment each file's prose into blocks and compare blocks pairwise by Jaccard similarity over 5-word shingles. Segmentation strips fenced code first, at the document level, so a `#` inside a fence (a shell comment, a documented heading example) is never read as a heading and fenced code never leaks into the comparison; fence open and close follow CommonMark (a block closes only on a same-character run at least as long, with no info string), so a mismatched or shorter inner fence stays code. Input is newline-normalized on read (CRLF to LF), so Windows line endings do not defeat the fence and heading scans. Only standard ``` / ~~~ fences are stripped; indented and blockquote-nested code blocks are not, a deferred edge. It then splits on Markdown headings and drops tables and path/link-only lines, normalizing the rest. A block with fewer than `duplicationShingleSize` words compares as a single whole-block shingle, so a short-but-substantive block (over the token floor) is still matched. Flag a pair when a block pair scores >= `duplicationSimilarityFloor` (0.80) and the block is >= `duplicationMinBlockTokens` (40) tokens. Excluded from the candidate set: the always-loaded `.memory/` store, auto-discovered skills, numbered-stage work files (transient per-task scratch), and retired `archives/` content, where shared or templated prose is expected rather than drift (a future `init` generator's scaffolding will join this list). Two work products (per-item `working` files) are not compared against each other, since templated deliverables across engagements share structure by design; a work product is still compared against durable content (`identity`, `situational`, `reference`), where shared prose is the cross-home drift the rule targets. Shared short headings, link-only lines, and stage-contract section labels do not count. The token floor measures a block's raw size, so a heavily-repeated short line clears it on a small unique-shingle set: such repeated boilerplate copied across routed homes is itself duplication and is flagged; a unique-shingle minimum to discount pure repetition is deferred to calibration. Each duplicated pair emits one finding per side, naming the other path. Original to icm-kit; no counterpart in the paper.

**Severity:** warning.

### 4.9 `SUPERSEDED_BUT_LIVE`

A file carrying a "superseded / deprecated / reframed" banner near its top that is still classified into a live (non-archive) routing home, so the agent still reads it as current. Original to icm-kit; a banner-signal variant of `STALE_CONTENT` (§4.3), enforcing W5 from the opposite side of `HIDDEN_CONTEXT`.

**Detection (v0.10):** the file is live-routed (has a classification, not under a retired-content home such as `archives/`) and its top region (the preamble plus the first heading section, up to `supersededBannerScanLines` lines, default 15) contains a banner line. Fenced code is stripped before the scan (as for §4.8), so a marker word inside a code example does not count. A banner line begins, after stripping leading blockquote/emphasis/heading/bracket punctuation (`>`, `*`, `_`, `#`, backticks, `(`) plus any leading emoji or variation-selector run (so a banner prefixed with a warning glyph such as `> **⚠️ REFRAMED ...` still reaches the marker), with a status marker. The match is at line start, not anywhere in the line, so a mid-line mention of a deprecation does not trip it. Markers come in two classes: **phrase markers** (`replaced by`, `no longer current`) are self-complete and fire bare, since they typically precede a target path; **single-word markers** (`superseded`, `deprecated`, `reframed`, `retired`, `obsolete`, `do not use`) fire only when label-shaped, i.e. the marker is the whole line, or is immediately followed by a separator (`: . , ; ! ?`, a closing bracket), a closing emphasis mark (`* _ ~` or a backtick), a label-terminated ISO date, or `by`/`as`. A **label-terminated ISO date** is a `YYYY-MM-DD` date immediately after the marker that is itself followed by line-end, a separator, an opening or closing bracket, an em-dash, a closing emphasis mark, or `by`/`as`; the post-date anchor is what distinguishes a dated banner from a sentence that merely opens with a marker and a date. So `Deprecated:`, `Deprecated.`, `(Deprecated)`, `Superseded by build-c.md`, `Reframed as the new lens`, and the dated `SUPERSEDED 2026-06-01 by ...` and `REFRAMED 2026-06-03 (see ...)` shapes fire (a date trailed by an em-dash note fires the same way), while a live document whose first line merely opens with a marker word (`# Deprecated features`, `Do not use tabs`, `Deprecated 2024 roadmap`) or runs a marker and a date on into prose (`Deprecated 2024-01-15 was the original ship date`) does not. A bare year or a following word is not a date match. A `status:` line whose value is `superseded`/`deprecated`/`retired` also fires. `archived` is deliberately not a marker: it overlaps the `archives/` guard and would mislabel rather than clarify. The fix is to move the file to `archives/`. Detection stays line-start and top-region scoped: a supersession mentioned only mid-line (`... the recon notes are now superseded by reading the real code`), or under a heading below the scan cap, is not yet caught; whether F9 should become section- or file-level for those is an open product call (§5). Time-based staleness remains deferred (§5).

**Severity:** warning.

---

## 5. Out of scope for v0.1

Explicitly deferred to later versions:

- **Vendor parity** beyond `CLAUDE.md`. `AGENTS.md` and other vendor variants are conceptually the same role but are not recognised by the v0.1 classifier.
- **Time-based stale-content heuristics.** File-age and last-modified-vs-activity signals for `STALE_CONTENT` (§4.3) remain deferred. Git *ancestry* is now partly consumed: `KIT_BOILERPLATE` (§4.7) reads commit reachability from a fork-point commit to detect never-adapted files. File *age* itself, and last-modified timestamps, are still not signals.
- **`SUPERSEDED_BUT_LIVE` scope: section- vs file-level.** F9 (§4.9) scans line-start markers in the top region only. A supersession that lives mid-line in prose (a sentence that happens to say a file's notes are now superseded) or under a heading below the scan cap is not caught. Promoting F9 to match mid-line markers, or to treat a `## Superseded` heading deep in a live file as marking the whole file (file-level) versus only its section (section-level), is a product call deferred until the trade-off against the mid-line false-positive class (a passing mention of a deprecation must stay silent) is settled.
- **`LAYER_BLOAT` stub-of-its-pointer detection.** F5 (§4.5) exempts oversized lead-contract prose by identity-heading shape, but a **small** misplaced ops stub (an identity-file section that restates a dedicated lower-level routed file, e.g. an iMessage or email stub duplicating its own `*-workflow.md`) sits under the size cap and is not caught. Catching it needs a "section-is-a-stub-of-the-file-it-points-to" topic-correspondence signal: pointer-presence alone cannot separate the stub from a legitimate contract block that also links many different-concern supporting files, and a similarity signal would drift into F8's (§4.8) lane. Deferred; the stub's current silence is honest under-reporting (§ Purpose), not a defect to tune away.
- **Task-type taxonomy.** Load/skip table task identifiers are parsed as opaque strings; no external vocabulary is validated.
- **Load/skip-table type-precedence.** v0.1 treats an explicit load/skip mention as a routability fallback (it rescues otherwise-unclassified files; §2.5). Reclassifying a canonical-home file through an explicit per-file load rule (full type-precedence) needs a pinned table format and is deferred to v0.2.
- **Severity tiers beyond warning.** No `error` severity in v0.1; everything is advisory.
- **Configuration surface.** Thresholds, alternative folder names, and ignore lists are configurable in principle; the spec does not yet pin the configuration file format.
- **Output format for `audit`.** Reporting structure (text, JSON, SARIF) is the tool's concern, not the spec's.

---

## 6. Versioning

This is **SPEC v1.0**. The spec evolves alongside `init` and `audit`. Breaking changes to classifications, rule identifiers, or well-formedness criteria are minor version bumps (0.x). v0.2 added the `.memory/`, `.claude/skills/`, and stage-working-file rows to the §2.5 classification table; v0.3 scoped the F1 size check to UTF-8 text (binaries are no longer byte-estimated, §4.1); v0.4 broadens the stage-working-file row from `NN-name/*.md` (immediate children only) to `NN-name/**/*.md` (anywhere under the stage folder, so a stage subfolder such as `specs/` routes its work products at L2), with the stage-contract row staying immediate-parent and keeping precedence; v0.5 resolves F3 pointers within the load/skip cell, so a bare name qualifies against a same-cell directory token and a bare structural basename (`CONTEXT.md`, `CLAUDE.md`) is a placeholder, not a dangling pointer (§4.3); v0.6 adds the `DUPLICATION` failure mode (`F8`, §4.8), a whole-workspace check that flags the same substantive prose living in two separately-routed homes; v0.7 adds the `SUPERSEDED_BUT_LIVE` failure mode (`F9`, §4.9), a per-file check that flags a file still routed into a live home despite a superseded/deprecated banner near its top, and newline-normalizes input on read (CRLF to LF) so the §4.8 fence and heading scans are robust to Windows line endings; v0.8 adds the `KIT_BOILERPLATE` failure mode (`F7`, §4.7), the first rule to consult git history (it flags a file inherited from the workspace's fork-point commit and never adapted since), filling the previously reserved 4.7 slot so the failure-mode codes are now contiguous `F1` through `F9`; v0.9 normalizes F3 load/skip pointers before the existence test, resolving each candidate relative to the directory of its containing CLAUDE.md with `.`/`..` collapsed (so a nested workspace's cross-altitude `../../` and sibling `../` references resolve against the tree's normalized paths), and dedups F3 to one finding per stale pointer per CLAUDE.md (§4.3); v0.10 hardens F9 banner detection (§4.9) so the real AIOS dogfood shapes it under-caught now fire: the punctuation strip also consumes a leading emoji/variation-selector run (`> **⚠️ REFRAMED ...`), and a single-word marker trailed by a label-terminated ISO date is label-shaped (`SUPERSEDED 2026-06-01 by ...`, `REFRAMED 2026-06-03 (see ...)`), while a mid-line or below-cap supersession stays deferred as a section- vs file-level product call (§5); v0.11 exempts append-only logs from the F1 hard size signal (§4.1): a file whose body is a run of at least three dated entry headings (a decisions log, an async channel) is an accreting ledger that grows by design, so a size finding would be a false positive (the remedy is a tail-archive, not a split); v0.12 makes F2/W5 routability transitive (§2.5, §4.2): routability is now a whole-workspace reachability closure (seeded with today's per-file routing, then expanded by following the Markdown links of any routed file and the load/skip cells of a routed `CLAUDE.md`), so a file routed only by a routed pointer or index file's links is no longer mis-flagged as hidden, while a genuine orphan, and a dead, external, or `#anchor` link, route nothing; v0.13 sharpens two heuristics against AIOS dogfood false positives: F6/W7 (§4.6, §3) strips a trailing dash-qualifier (a spaced em-dash or en-dash and the text after it) before matching a stage-contract heading, so a qualified `## Process` heading carrying a repeat cadence satisfies `Process`, and the F1 soft signal / W3 (§4.1) exempts a transient leaf work file (a per-item `working` product such as a numbered-stage call agenda) whose intrinsic behaviour block is the deliverable, while an always-loaded standing file mixing content still fires; v0.14 sharpens F5 (§4.5) identity discrimination against the last AIOS dogfood false positive: identity-by-heading-shape now also recognises lead-contract / operating-model headings (`operating model`, `compartmentalisation`, the `what this ... is` self-definition shape), matched against the normalized whole heading (per §4.6), not by substring, so an oversized root operating-model / lead-contract block is contract prose rather than layer bloat, while a situational heading reusing a contract word (`## Operating model in practice`, `## Out of scope this sprint`) still fires when oversized, and catching the small below-cap ops stubs that restate a dedicated routed file stays deferred (§5); v0.15 adds the normative **§7 (Generation / the `init` template)**, the canonical workspace `init` emits, specified as the inverse of §2.5/§3/§4 so it classifies cleanly and audits to zero findings (the audit-green invariant): it pins the load-bearing root link-manifest routing rule, the role-less default and the minimal role shape, the neutral (dispositions-free) skeleton and the scaffolded-but-unwired `.memory/`, the non-git-initialized output (so F7 stays silent, §4.7), the install-level `references/` locality carve-out, the `begin`/session-start `handoff.md` fall-through, and the `identity/` routing resolution (routed by the root link-manifest, with promotion to a recognised §2.5 home deferred as a classifier change); v0.16 corrects §7.3 to pin the generated root's two proven audit-green routing surfaces (a role-routing `| Task | Load | Skip |` table, which IS a Load/Skip table whose every Load cell resolves to a real in-tree file while its Skip cells stay prose-only, and a plain-Markdown body link-manifest that routes the substrate homes through the F2 closure carrying no Load/Skip pointer), replacing the earlier §7.3 claim that the role-routing table was not a Load/Skip table, and lands the golden `src/templates/` byte tree that realises §7 (the neutral, dispositions-free workspace that audits to zero findings); **v1.0** is the first stable spec, landing with both §6 preconditions met: `init` and `audit` both ship end-to-end against the spec, and a full workspace audit cycle has been run against the production AIOS fork and a clean generated workspace. The first stable spec lands as **1.0** when both `init` and `audit` ship end-to-end against it and a full workspace audit cycle has been run against a production system (AIOS) and a clean generated workspace.

---

## 7. Generation / the `init` template

`init` generates a workspace; §7 specifies the canonical one it emits. Where §2.5, §3, and §4 read a workspace and classify or fault it, §7 is their inverse: it fixes the exact shape such that `classify()` finds every file compliant and `audit()` returns zero findings. §7 is normative for `init`; the generator (a later subtask) is correct exactly when its output satisfies this section.

### 7.1 The audit-green invariant

**`init`'s output is the canonical workspace: every well-formedness rule W1 to W7 holds and no failure mode F1 to F9 fires.** A freshly generated, un-ignited tree audits to zero findings. This is an invariant, not a target: any file `init` emits that would trip a rule is a defect in the template or in this spec, resolved (per the project's spec-driven discipline) by fixing the template or amending §7, never by exempting `init`'s output inside the audit runner. The rest of §7 is written to hold this invariant, and each home below notes the rules it must stay clear of.

### 7.2 The generated layout

The role-less default is the shape `init` emits when no role is selected:

```
CLAUDE.md            root identity + lead contract + role-routing table + link-manifest + session-start
connections.md       external-connection registry (stub)
README.md            human-facing orientation
CONVENTIONS.md       working conventions, including the real audit command
EXPANSIONS.md        how to grow the workspace (add a role, a channel, a stage)
BOOTSTRAP.md         the ignition packet; self-deletes after the first session
board/STATE.md       active-state board
decisions/log.md     append-only decision log (stub)
sync/protocol.md     async-coordination protocol
channels/            async channel files (starter channel or index)
identity/            operator-identity home; empty in the neutral default (.gitkeep)
.memory/             recognised agent-memory home; scaffolded but unwired, empty (.gitkeep)
archives/            retired-content home; walk-ignored, so the audit never reads it (.gitkeep)
references/
  agent-roles.md            the roles the lead contract points at
  voice.md                  neutral-register placeholder
  context-architecture.md   the ICM primer
workspaces/          role workspaces; the role-less default holds only .gitkeep
.claude/
  settings.json             harness baseline
  settings.local.json       per-operator stub
.githooks/pre-commit  warn-mode altitude gate (runs audit, never blocks a commit)
```

Every generated Markdown home, with its classification (per §2.5) and how the audit reaches it:

| Generated path | content_type | load_pattern | routing_level | Routed by |
|---|---|---|---|---|
| `CLAUDE.md` | identity (+ operations) | always | L0 | canonical, §2.5 row 1 |
| `references/**/*.md` | reference | on_demand | L0 scope | canonical, §2.5 row 3 |
| `.memory/**/*.md` (empty by default) | situational | always | L0 scope | canonical, §2.5 row 2b |
| `workspaces/<role>/CLAUDE.md` (when a role is added) | identity | always | L1 | canonical, §2.5 row 1 (nested) |
| `workspaces/<role>/context/**/*.md` (when a role is added) | situational | always | L1 | canonical, §2.5 row 2 |
| `board/*.md`, `decisions/log.md`, `sync/protocol.md`, `channels/*.md`, `identity/*.md` | working | per_item | L0 | classified (§2.5 row 5): the enclosing folder is a declared work folder, harvested from the root manifest's `folder/file.md` links |
| `README.md`, `CONVENTIONS.md`, `EXPANSIONS.md`, `connections.md` | reference | on_demand | L0 | classified (§2.5 load/skip naming fallback): named by the root `CLAUDE.md` |
| `BOOTSTRAP.md` | reference | on_demand | L0 | classified (§2.5 naming fallback): named by a session-start prose link, never a Load/Skip-table row |

The substrate and documentation homes (`board/`, `decisions/`, `sync/`, `channels/`, `connections.md`, the three root docs, `identity/`) are not canonical §2.5 homes, but because the root link-manifest links each of them, the per-file classifier does **not** leave them unclassified: it types every one. The folder substrate (`board/`, `decisions/`, `sync/`, `channels/`, `identity/`) classifies as **`working`** (§2.5 row 5): the manifest's `folder/file.md` links make each enclosing folder a declared work folder, so its Markdown files route as per-item work products. The root companions (`README.md`, `CONVENTIONS.md`, `EXPANSIONS.md`, `connections.md`, `BOOTSTRAP.md`) classify as **`reference`** (the §2.5 load/skip naming fallback): each is named by the root, so it routes on demand. Each file is therefore a classification seed, routed directly rather than only through the transitive closure (§4.2), so W5 / F2 is satisfied.

Because they are classified, these files sit **inside** the content-segregation (W3 / F1 soft), duplication (F8), superseded-banner (F9), and kit-boilerplate (F7) candidate sets, not outside them; `init`'s output stays audit-green because its authored bytes hold each rule rather than because the files are exempt. The `working` files are exempt from W3 (a work product may carry a behaviour block) and pair-skip each other under F8 (two work products are not flagged against each other); the `reference` files carry no dense behaviour block (W3 / F1 soft) and no prose that duplicates another routed home (F8); none carries a superseded banner (F9); and F7 stays silent because `init` emits a non-git tree (§7.8). The §2.5 table and the classifier are unchanged.

Non-Markdown files (`.gitkeep`, `.claude/*.json`, `.githooks/pre-commit`) carry no classification and are not subject to F2: routability is a Markdown-only property (§4.2). `archives/` is walk-ignored by the workspace reader, so its contents never enter the audit at all.

### 7.3 The root `CLAUDE.md` and the link-manifest rule

The generated root is **thin**: an identity preamble, the L0 lead contract (a pointer to `references/agent-roles.md`, not the roles inlined), a role-routing table, a link-manifest, and a session-start handshake. It carries **no inlined knowledge and no voice**: the substance lives in the routed `references/` files, so the root stays under the F1 4,000-token `CLAUDE.md` cap and shares no duplicated block with any reference (F8).

**The link-manifest rule (load-bearing).** `board/`, `decisions/`, `sync/`, `channels/`, `identity/`, and the root companions `connections.md`, `README.md`, `CONVENTIONS.md`, and `EXPANSIONS.md` are not canonical homes; each is **F2-hidden unless the root `CLAUDE.md` links it.** The generated root therefore MUST carry a complete link-manifest: a Markdown link that resolves to at least one file in every generated home, and, where a home holds several Markdown files, its entry or index file links the rest, so the F2 reachability closure (§4.2) reaches every generated Markdown file. The manifest links are **Markdown links, not a Load/Skip table**: this routes the homes for F2 while keeping F3 silent (F3 reads only Load/Skip-table cells), so a home file later renamed or removed leaves no dangling F3 pointer. The generated root carries two routing surfaces, both proven audit-green on the reference install: (a) a role-routing table with a resolving | Task | Load | Skip | header whose Load cells point at on-demand references/ files (and any generated skills) - this IS a Load/Skip table (F3 reads its Load-cell pointers), and F3 stays silent because every Load-cell target resolves to a real in-tree file (4.3), while its Skip cells carry prose only so F3 extracts no pointer from them, and F5 variant A stays silent because role workspaces are named by directory (workspaces/<thread>/), never as a cross-altitude Load pointer into a child workspace; and (b) a body link-manifest of plain Markdown links routing the always-loaded substrate homes (board/, decisions/, sync/, channels/, identity/, connections.md, README.md, CONVENTIONS.md, EXPANSIONS.md), which route via the F2 transitive closure (4.2) while carrying no Load/Skip pointer, so a substrate file renamed or removed leaves no dangling F3 pointer. The requirement is that every Load-cell resolves to an existing generated file and every generated home is reached by at least one manifest link. The whole manifest fits well within the 4,000-token budget.

**The `begin` / session-start fall-through.** The generated session-start handshake (in the root, and in any role charter) references `handoff.md` conditionally, in prose: read `handoff.md` if it exists, otherwise fall through cleanly to the ACTIVE stage or the standing structure. `handoff.md` is never a Load/Skip pointer, so a fresh workspace with no handoff present neither dead-ends the agent on "read handoff.md first" nor trips F3.

### 7.4 Substrate homes and the `identity/` resolution

`board/STATE.md`, `decisions/log.md` (an append-only log stub, which the F1 hard size signal exempts once it accretes, §4.1), `sync/protocol.md`, and the `channels/` files are the coordination substrate; each is routed by the link-manifest (§7.3). `connections.md` is the root external-connection registry, routed the same way.

`.memory/` is the recognised agent-memory home (§2.5 row 2b). `init` **scaffolds it but leaves it unwired**: it is generated empty (held by `.gitkeep`), because agent memory accretes at runtime, not at generation. An empty `.memory/` contributes no Markdown file and so no finding.

**The `identity/` resolution.** `identity/` is a de-facto home that the §2.5 table does not recognise, and it is load-bearing in every real install. Rather than widen the classifier (a code change out of this spec-only step's scope, and one that would reclassify existing installs), §7 pins an explicit routing rule: **whenever `identity/` holds Markdown files, the root link-manifest links them** (the always-link-`identity/*` rule), so they route and audit clean like the other substrate homes. In the neutral role-less default `identity/` ships **populated** with two generic, name-neutral identity files (`decision-boundary.md` and `email-workflow.md`), so the rule is **active, not vacuous**: the root manifest links both, and because those `identity/file.md` links make `identity/` a declared work folder, the classifier types the two files as `working` (per_item), not unclassified. Promoting `identity/` to a recognised `situational`/`identity` row in the §2.5 table (so the classifier routes it directly as always-loaded identity, independent of the manifest and of the work-folder harvest) is a reasonable future step; it is deferred here because it is a classifier change, and the link-manifest rule already keeps `init`'s output audit-green in the meantime.

### 7.5 Shared references and the locality carve-out

`references/` holds three install-level companions, all canonical `reference` files (on_demand, §2.5 row 3), all routed with no F2 finding:

- `agent-roles.md`: the role definitions the root lead contract points at.
- `voice.md`: a **neutral-register placeholder**. It is deliberately not a dense rules block: a real voice file packed with directives would trip the F1 soft signal / W3 (a `reference` carrying a behaviour block), so the generated placeholder states a neutral register and defers actual voice to the operator overlay (§7.8).
- `context-architecture.md`: a short ICM primer.

**The `references/` locality carve-out.** A future locality expectation ("push references down to where they are used; a reference stranded at the install root is a smell") is in tension with an install-level root `references/`. §7 states that these three install-level `references/` companions are **exempt** from that locality expectation: they are shared across every role by design, so a locality audit rule, if added later, must not false-positive on `init`'s own output.

### 7.6 Role workspaces

**Role-less default.** `init` emits `workspaces/` holding only `.gitkeep`: no role is assumed. A role is an opt-in expansion (documented in `EXPANSIONS.md`).

**Minimal role shape.** When a role is added, its workspace is the minimal L1 shape: a `CLAUDE.md` charter and a `context/` home, and nothing else. `init` does **not** pre-build empty `references/` or `.claude/skills/` levels for a role; those are added only when the role needs them. A role `CLAUDE.md` is L1 in the parent frame (§2.2), its `context/**/*.md` is situational/always at L1, and routing depth stays at 2, well under the W6 limit of 3. The role charter's session-start handshake follows the same `begin` fall-through as the root (§7.3).

### 7.7 Harness baseline, self-documenting docs, and the ignition packet

**Harness baseline.** `init` emits `.claude/settings.json` (the harness baseline), a `.claude/settings.local.json` stub (per-operator), and a `.githooks/pre-commit` altitude gate that runs the audit in **warn mode**: it reports findings but never blocks a commit. All three are non-Markdown and generate no audit finding.

**Self-documenting docs.** `CONVENTIONS.md` records the working conventions, including the **real audit command** (the actual `audit` invocation for this workspace, not a bare-binary placeholder). `EXPANSIONS.md` documents how to grow the workspace (add a role, a channel, a stage contract). `README.md` is human-facing orientation. All three are routed by the link-manifest (§7.3).

**The ignition packet.** `BOOTSTRAP.md` is the one-shot ignition packet. It is routed by a **Markdown link in the root's session-start prose only, never a Load/Skip-table row.** While present it is reachable, so F2 is clear; it is designed to **self-delete after the first session**, and because nothing in a table points at it, its deletion leaves no dangling F3 pointer, only an inert dead prose link that routes nothing (§4.2). That is why the packet is prose-linked rather than table-routed.

### 7.8 Generation guarantees

Two properties hold across the whole generated tree:

- **Non-git-initialised (`tracked: false`).** `init` emits a plain directory tree; it does **not** run `git init`. Every file therefore reads as off-repo, so F7 (`KIT_BOILERPLATE`), which needs git history from a fork-point commit, stays silent on a genuinely fresh install (§4.7). Initialising git is the operator's first act, and from that point the workspace's own history, not `init`'s, is what F7 reads.
- **Neutral skeleton.** The generated workspace is behaviourally neutral: no personality, voice rules, or behavioural dispositions are baked in. Those are an opt-in **operator-profile overlay** applied after generation, not part of the skeleton. This keeps the neutral `voice.md` placeholder clear of the F1 soft signal / W3 and keeps `init`'s output identical for every operator until they choose to specialise it.

---

## Open questions (for v0.1 review)

Items where the spec picked a precise answer but the answer is genuinely contested or under-specified by the paper:

1. **Workspace boundary detection.** v0.1 uses the presence of a `CLAUDE.md` as the sole workspace-boundary signal. Alternative: detect by the presence of an L0-shaped folder set (`context/` + `references/` + work folder). v0.1 picks the simpler rule; revisit if it produces false negatives.
2. **Mixed-content allowance in `CLAUDE.md`.** The spec allows identity + operations in `CLAUDE.md`. The paper's Identity vs Operations section suggests these may eventually separate (into `CONTEXT.md` per stage). v0.1 retains mixed `CLAUDE.md` for simple workspaces; the separated form is recognised at L2 via stage contracts.
3. **Default thresholds.** 4,000 tokens for `CLAUDE.md`, 8,000 for other single files, 500 tokens for the layer-bloat prose-block heuristic, depth 3 for over-routing. These are educated guesses tied to the paper's measurements. The v0.1 stance is **honest under-reporting**: the caps are a crude guard for egregiously large files and are deliberately not back-calculated to reproduce a hand-audit. A file a human calls "monolithic" by judgement (a 15KB root, a 21KB client doc) may sit under the size caps and be caught instead by `LAYER_BLOAT` / W3, or not mechanically caught at all. The audit reporting fewer findings than a hand-audit is the correct outcome, not a bug to tune away. Expect calibration once the linter runs against the real AIOS tree.
4. **Configurable recognised homes.** v0.2 hard-codes the harness homes (`.memory/`, `.claude/skills/`) and the workspace homes (`context/`, `references/`). An install that renames a home (`context/` to `docs/`, etc.) cannot yet declare it: that needs a `recognizedHomes` config option, which widens the `classify(path, tree, claudeMd)` signature and pins a config-file format. Deferred; the hard-coded harness defaults are enough to route the common case.
