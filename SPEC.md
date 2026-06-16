# ICM Spec: v0.1

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
- **situational**: always-relevant facts about the user or project that are not identity statements. Active state. Canonical home: `context/`.
- **reference**: durable, cross-cutting knowledge loaded on demand by task type. Canonical home: `references/`.
- **working**: per-task work products created and consumed during execution. Canonical home: a work folder (`projects/`, `chapters/`, `clients/`, numbered engagement stages, etc.).

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
| `references/**/*.md` | reference | on_demand | scope of enclosing workspace |
| Numbered stage folder, e.g. `NN-name/CONTEXT.md` | reference (stage contract) | on_demand | L2 |
| Any `*.md` under a folder mentioned in the enclosing `CLAUDE.md` as a work folder | working | per_item | scope of enclosing workspace |
| Subdirectory containing its own `CLAUDE.md` | introduces an L1 workspace; classify its contents recursively in that workspace's frame | n/a | L1 (from parent) |
| Any other `*.md` not matched above | unclassified → reported as Hidden context (§4.2) | n/a | n/a |

Files referenced explicitly by a `CLAUDE.md`'s load/skip table are routed by that reference. In v0.1 this acts as a **fallback**, evaluated after the default-table rows above: a load/skip mention rescues a file that no default row matched (it routes `on_demand` as a `reference`, satisfying W5), but it does **not** override the classification of a file already matched by its canonical home (rows 1 to 5 take precedence). Full **type-precedence**, where a table entry reclassifies a canonical-home file as `reference` or `working` per an explicit per-file load rule, requires parsing the load/skip table's per-file type assignments, whose format is not yet pinned (§5); it is deferred to v0.2. Until then, a canonical-home match wins.

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
- **W5 (`ROUTABLE_FILES`).** Every file in the workspace is reachable through a routing path: either its canonical location implies its load rule, or the enclosing workspace's `CLAUDE.md` mentions it by name or pattern.
- **W6 (`ROUTING_DEPTH`).** Workspace routing depth (per §2.2) is at most 3.
- **W7 (`STAGE_CONTRACT_SHAPE`).** Every `CONTEXT.md` file located in a numbered stage folder (pattern `NN-name/CONTEXT.md`) contains all four required section headings (`## Input`, `## Process`, `## Output`, `## Completion`; matched case-insensitively, tolerating a trailing plural), and each section has non-empty content.

---

## 4. Failure modes

Each failure mode is a lint rule, carrying a stable code (`F1` through `F6`, in section order 4.1 through 4.6) that the rule model and audit output use as its identifier. The first five (`F1` to `F5`) are derived directly from the paper's Failure Modes section. The sixth (`F6`, `MALFORMED_STAGE_CONTRACT`) is original to icm-kit and has no counterpart in the paper; it enforces the stage-contract shape required by W7 (§3). Severity in v0.1 is `warning` for all rules; an `error` severity is reserved for later.

### 4.1 `MONOLITHIC_CONTEXT`

A single file at any routing level grown so large or so mixed in content that it dominates the context window or violates content-type segregation.

**Detection (v0.1):**
- Hard signal: file size exceeds a threshold. Defaults: `CLAUDE.md` over 4,000 tokens; any other single file over 8,000 tokens. Token counts use tiktoken `cl100k_base` (wired via `js-tiktoken` in v0.1) as a proxy for Claude's tokenizer (see paper appendix); an unreadable or non-UTF-8 file falls back to a byte-based estimate so a binary monolith still trips the guard. Thresholds are configurable and stay at the defaults: a crude guard for egregiously large files, deliberately not tuned to reproduce any one hand-audit (see §5 open question 3).
- Soft signal: a single file (other than a `CLAUDE.md`, the only file permitted to mix identity and operations) contains content of more than one content type. v0.1 detects the common case: a non-identity file carrying a dense, contiguous block of behavioural directives. Detection is density-normalised, so a situational fact that merely narrates behaviour ("the client always pays cash") does not trip it; only a genuine rules block does.

**Severity:** warning.

### 4.2 `HIDDEN_CONTEXT`

A file that exists in the workspace tree but has no routing path. The agent will never read it under any task rule.

**Detection:** any `*.md` file not matched by the classification table and not mentioned by the enclosing workspace's `CLAUDE.md`. Excludes the audit tool's own metadata files (deferred to v0.2 once those exist).

**Severity:** warning.

### 4.3 `STALE_CONTENT`

Loaded content that no longer reflects current truth: load/skip tables out of sync with the file tree, references to retired conventions, situational facts marked as active that are no longer accurate.

**Detection (v0.1 partial):**
- The load/skip table references a file that does not exist. Pointers are read from the load/skip table rows only, not from prose, so template paths (`YYYY-MM-DD.md`) and cross-repo example paths mentioned in prose do not produce spurious findings.
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

**Severity:** warning.

### 4.6 `MALFORMED_STAGE_CONTRACT`

A stage contract `CONTEXT.md` missing one or more of the required IPO + C sections, or with an empty section.

**Detection:** Parse headings; verify all four sections (`## Input`, `## Process`, `## Output`, `## Completion`) are present, and each has at least one non-empty line of content beneath it. Heading matching is case-insensitive and tolerates a trailing plural (`## Inputs` satisfies `Input`).

**Severity:** warning.

---

## 5. Out of scope for v0.1

Explicitly deferred to later versions:

- **Vendor parity** beyond `CLAUDE.md`. `AGENTS.md` and other vendor variants are conceptually the same role but are not recognised by the v0.1 classifier.
- **Time-based stale-content heuristics.** File age and git activity as signals for `STALE_CONTENT` are deferred to v0.2.
- **Task-type taxonomy.** Load/skip table task identifiers are parsed as opaque strings; no external vocabulary is validated.
- **Load/skip-table type-precedence.** v0.1 treats an explicit load/skip mention as a routability fallback (it rescues otherwise-unclassified files; §2.5). Reclassifying a canonical-home file through an explicit per-file load rule (full type-precedence) needs a pinned table format and is deferred to v0.2.
- **Severity tiers beyond warning.** No `error` severity in v0.1; everything is advisory.
- **Configuration surface.** Thresholds, alternative folder names, and ignore lists are configurable in principle; the spec does not yet pin the configuration file format.
- **Output format for `audit`.** Reporting structure (text, JSON, SARIF) is the tool's concern, not the spec's.

---

## 6. Versioning

This is **SPEC v0.1**. The spec evolves alongside `init` and `audit`. Breaking changes to classifications, rule identifiers, or well-formedness criteria are minor version bumps (0.x). The first stable spec lands as **1.0** when both `init` and `audit` ship end-to-end against it and a full workspace audit cycle has been run against a production system (AIOS) and a clean generated workspace.

---

## Open questions (for v0.1 review)

Items where the spec picked a precise answer but the answer is genuinely contested or under-specified by the paper:

1. **Workspace boundary detection.** v0.1 uses the presence of a `CLAUDE.md` as the sole workspace-boundary signal. Alternative: detect by the presence of an L0-shaped folder set (`context/` + `references/` + work folder). v0.1 picks the simpler rule; revisit if it produces false negatives.
2. **Mixed-content allowance in `CLAUDE.md`.** The spec allows identity + operations in `CLAUDE.md`. The paper's Identity vs Operations section suggests these may eventually separate (into `CONTEXT.md` per stage). v0.1 retains mixed `CLAUDE.md` for simple workspaces; the separated form is recognised at L2 via stage contracts.
3. **Default thresholds.** 4,000 tokens for `CLAUDE.md`, 8,000 for other single files, 500 tokens for the layer-bloat prose-block heuristic, depth 3 for over-routing. These are educated guesses tied to the paper's measurements. The v0.1 stance is **honest under-reporting**: the caps are a crude guard for egregiously large files and are deliberately not back-calculated to reproduce a hand-audit. A file a human calls "monolithic" by judgement (a 15KB root, a 21KB client doc) may sit under the size caps and be caught instead by `LAYER_BLOAT` / W3, or not mechanically caught at all. The audit reporting fewer findings than a hand-audit is the correct outcome, not a bug to tune away. Expect calibration once the linter runs against the real AIOS tree.
