# icm-kit

The TypeScript implementation of icm-kit, the OSS tool that operationalizes the Interpretable Context Methodology described in [usebessemer/research/theory/context-as-architecture.md](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md).

## What this project is

A CLI with three commands sharing a single ICM rule model:

- `init`: scaffold a new ICM-compliant workspace that audits green. `--role <name>` also scaffolds a minimal L1 role workspace (§7.6); `--class devlead` instead scaffolds an audit-green L1 delegating-lead binder (§7.9); the two flags are mutually exclusive.
- `audit`: check an existing workspace against the rule model and report violations.
- `sanitize`: project a private workspace into a shareable form: `--mode support` (whole-workspace remote-support bundle) or `--mode extract --include <paths...>` (scoped capability harvest); fail-closed on secrets, deterministic.

The rule model encodes the paper's classification (routing level, content type, load pattern), well-formedness rules (`W1` to `W7`), failure modes (`F1` to `F9`, contiguous), the generation contract (§7), and the projection contract (§8) in a single language-agnostic spec that all three commands consume.

## Source of truth

`SPEC.md` is the authoritative behaviour contract. Every classification rule, well-formedness check, and failure mode is defined there first.

## Development discipline (spec-driven)

icm-kit is developed spec-driven. The single rule with operational teeth:

**Any change that affects the classifier or its rules updates `SPEC.md` and the code in the same PR. The spec wins on disagreement.**

If the spec is ambiguous or wrong, update the spec (or open an issue) before changing the code. Never silently drift code from spec.

## Stack

- TypeScript / Node 20+, ESM throughout.
- `tsx` for the dev runtime, `tsc` for the build.
- `commander` for the CLI.
- `vitest` for tests, `eslint` (flat config) with `typescript-eslint` for lint.

Scripts:

- `npm run dev -- <subcommand>`: run the CLI against the source.
- `npm run typecheck`: type-check without emit.
- `npm run lint`: lint `src/` and `tests/`.
- `npm test`: run the test suite once.
- `npm run test:watch`: run tests in watch mode.
- `npm run build`: emit compiled JS to `dist/`.

## Voice and conventions

- No em dashes in code, comments, docs, or commit messages. Use colons or semicolons instead.
- TypeScript strict mode is on; honour it.
- Conventional Commits format for commit messages.
- Branching follows the org pattern: `feature/<short-description>` off `develop`; one PR per issue, reviewed before merge (see "Working with the overseer" below). `develop -> main` at version cuts only.

## Current focus

v1.5 ships all three commands end-to-end against the spec: `audit`, `init` (with the `--role` and `--class devlead` expansions), and `sanitize` (`support` + `extract` modes). Current work is hardening and calibration; the next spec extension is the `--domain` axis for the class binder, deferred until a second built lead-domain forces it (§7.9).

## Working with the overseer (L0)

You are a **dev leaf** in Stu's OSS stream: you author code here against the GitHub issues; an **L0 overseer** (running in Stu's AI-OS workspace) reviews your PRs; Stu merges. You make no product, scope, or spec decisions, you surface them.

**Coordination happens on the artifact, never through the human. Stu is not your courier.**

- **A finished unit of work** -> open a PR. Its description is your report: what you built, how you verified, and what you are surfacing.
- **Clarification, or a decision you cannot resolve from `SPEC.md` or the issue** -> post a comment on the relevant **issue or PR**, then carry on with anything it does not block. The overseer reads and answers on that thread. Do not ask the human in chat; put the question on the artifact so the answer is durable and the overseer can act on it.
- **Surface, don't absorb** -> anything beyond an issue's acceptance criteria (a SPEC gap, an extra rule, a risky cleanup) is flagged on the issue or PR, not silently built or silently dropped.

Conventions: branch `feature/* -> develop -> main`, one PR per issue, reviewed before merge. **No `Co-Authored-By: Claude` trailer** on any commit. Test-first. The spec wins on disagreement (see Development discipline above).

## Dev-leaf task intake (you are a CodeExecutor leaf for this repo)
On launch, find your task, do not wait for a pasted brief:
1. `gh issue list --label dev-ready --state open` → work that issue (lowest number if several; if none, ask).
2. `gh issue view <n>` → the body IS your spec, acceptance criteria, branch, and version target.
3. Build per this repo's conventions (spec-driven; branch flow; no Claude trailer). Clarifications/progress on the PR/issue, never to the human. Open the PR, re-request the lead's review. The lead merges feature->develop once green; you never self-merge.
