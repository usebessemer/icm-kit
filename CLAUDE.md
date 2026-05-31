# icm-kit

The TypeScript implementation of icm-kit, the OSS tool that operationalizes the Interpretable Context Methodology described in [usebessemer/research/theory/context-as-architecture.md](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md).

## What this project is

A CLI with two commands sharing a single ICM rule model:

- `init`: scaffold a new ICM-compliant workspace.
- `audit`: check an existing workspace against the rule model and report violations.

The rule model encodes the paper's classification (routing level, content type, load pattern), well-formedness rules (`W1` to `W7`), and failure modes (`F1` to `F6`) in a single language-agnostic spec that both commands consume.

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
