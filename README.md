# icm-kit

Tooling for the Interpretable Context Methodology (ICM), an architecture for organizing the folders and files an agent reads. icm-kit provides three commands sharing a single rule model:

- **`audit`** (implemented): check an existing workspace against the rule model and report violations of the ICM failure modes.
- **`init`** (implemented): scaffold a new ICM-compliant workspace that audits green. `--role <name>` also scaffolds a minimal L1 role workspace; `--class devlead` instead scaffolds an audit-green L1 delegating-lead binder (a `(Lead, Standing)` workspace pre-filled with the reusable delegating-lead contract). `--role` and `--class` are mutually exclusive. See SPEC §7.6 / §7.9.
- **`sanitize`** (implemented): project a private workspace into a shareable form. `--mode support` produces a whole-workspace remote-support bundle; `--mode extract --include <paths...>` produces a scoped capability harvest (a named slice plus its minimal routing context). Both classify every file first, fail closed on anything they cannot home, omit secrets and assert their absence, and are deterministic.

### The leak-check is a required stage, not an option

`sanitize` mechanizes the redaction **rules**; it does not verify the **outcome**. For any **public-destined** output (the `extract` mode's purpose), an **independent adversarial leak-check is a required pipeline stage.** The tool redacts the homes where private instance concentrates and emits `pass_through` targets (a skill's `SKILL.md`, a shared reference) verbatim; it does not scan those for arbitrary names. The precedent is on record (2026-07-05): a self-run sanitization pass on public material missed a live email address, a raw internal spec, and real customer names, all caught by independent eyes before the push. The invariant: **the machine pass feeds the adversarial pass; it never substitutes for it.** See [`SPEC.md`](SPEC.md) §8.6.

### The delegating-lead binder (`init --class devlead`)

`init --class devlead` stamps a ready-to-run L1 delegating-lead workspace below an existing root: a `(Lead, Standing)` cell that holds a board, routes work to a dev leaf, and surfaces decisions without authoring the work itself. It emits exactly two files under `workspaces/<class>/` (the delegating-lead charter `CLAUDE.md` and a non-directive `context/leaf.md`) and nothing else; routing depth stays at 2 and the synthesized tree audits to zero findings by construction. The binder is the class analog of `--role`: where `--role` emits a generic minimal stream, `--class` pre-fills the reusable delegating-lead contract. v1 ships one class value, `devlead`. It is mutually exclusive with `--role`, and it never mutates `registry.md` or any other existing file (adding the registry row is documented as a one-line operator action in the emitted charter). The binder complements ignition rather than competing with it: ignition stands up the root once on a fresh install; the binder stamps an L1 class below an already-existing root, repeatedly. See [`SPEC.md`](SPEC.md) §7.9.

## Background

ICM is described in [*Context as Architecture*](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md), which extends Van Clief and McDermott's *Interpretable Context Methodology* (arXiv:2603.16021) with a two-axes reframing (routing hierarchy and load pattern combined with content type) and adds a Completion field to stage contracts.

icm-kit is the applied counterpart: a tool that operationalizes the paper's classification and failure modes.

## Status: v1.5

All three commands ship end-to-end. `audit` runs the §2.5 file classifier and the W1-W7 / F1-F9 rule set, validated against a real production workspace. `init` generates the audit-green golden template (the normative §7 generation contract and the `src/templates/` byte tree), and gains two expansions: `--role <name>` scaffolds a minimal L1 role workspace (§7.6), and `--class devlead` scaffolds an audit-green L1 delegating-lead binder (§7.9). `sanitize` projects a private workspace into a shareable form: `--mode support` produces a whole-workspace remote-support bundle and `--mode extract --include <paths...>` produces a scoped capability harvest, both fail-closed on secrets and deterministic (§8).

- [`SPEC.md`](SPEC.md): the formal model (v1.5), well-formedness rules, failure modes, stage-contract requirements, the generation contract (§7), and the projection/sanitize contract (§8).

## Roadmap

- **v0.1 to v1.5** (shipped): the rule model, the §2.5 classifier, `audit`, `init` (with `--role` and `--class devlead`), and `sanitize` (`support` + `extract` modes), all hardened against a real production workspace.
- **next**: a second built lead-domain unlocks the deferred `--domain` axis for the class binder (§7.9); calibration of the F1/F5 thresholds against more real trees.

## Development

icm-kit is developed spec-driven. `SPEC.md` is the source of truth for behaviour. Any change that affects the classifier or its rules updates `SPEC.md` and the code in the same PR. If the spec is ambiguous or wrong, update the spec (or open an issue) before changing the code.

## License

MIT. See [LICENSE](LICENSE).
