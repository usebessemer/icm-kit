# icm-kit

The TypeScript implementation of icm-kit, the OSS tool that operationalizes the Interpretable Context Methodology described in [usebessemer/research/theory/context-as-architecture.md](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md).

## What this project is

A CLI with two commands sharing a single ICM rule model:

- `init`: scaffold a new ICM-compliant workspace.
- `audit`: check an existing workspace against the rule model and report violations.

The rule model encodes the paper's classification (routing level, content type, load pattern), well-formedness rules (`W1` to `W7`), and failure modes (`F1` to `F6` plus `F8` and `F9`; `F7` is reserved and in flight, so the codes are briefly non-contiguous) in a single language-agnostic spec that both commands consume.

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
- Branching follows the org pattern: `feature/<short-description>` off `main`; PR for substantive work; small fixes may commit directly.

## Current focus

Encode the rule model in TS types against `SPEC.md` (the v0.1 to v0.2 step). Once the rule model is in place, build the classifier, then `init`, then `audit`. Scaffolding (package.json, tsconfig, eslint, vitest, commander stubs) is already in.

## Working with the overseer (L0)

You are a **dev leaf** in Stu's OSS stream: you author code here against the GitHub issues; an **L0 overseer** (running in Stu's AI-OS workspace) reviews your PRs; Stu merges. You make no product, scope, or spec decisions, you surface them.

**Coordination happens on the artifact, never through the human. Stu is not your courier.**

- **A finished unit of work** -> open a PR. Its description is your report: what you built, how you verified, and what you are surfacing.
- **Clarification, or a decision you cannot resolve from `SPEC.md` or the issue** -> post a comment on the relevant **issue or PR**, then carry on with anything it does not block. The overseer reads and answers on that thread. Do not ask the human in chat; put the question on the artifact so the answer is durable and the overseer can act on it.
- **Surface, don't absorb** -> anything beyond an issue's acceptance criteria (a SPEC gap, an extra rule, a risky cleanup) is flagged on the issue or PR, not silently built or silently dropped.

Conventions: branch `feature/* -> develop -> main`, one PR per issue, reviewed before merge. **No `Co-Authored-By: Claude` trailer** on any commit. Test-first. The spec wins on disagreement (see Development discipline above).
