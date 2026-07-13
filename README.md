# icm-kit

Tooling for the Interpretable Context Methodology (ICM), an architecture for organizing the folders and files an agent reads. icm-kit provides two commands sharing a single rule model:

- **`audit`** (implemented): check an existing workspace against the rule model and report violations of the ICM failure modes.
- **`init`** (implemented): scaffold a new ICM-compliant workspace that audits green.

## Background

ICM is described in [*Context as Architecture*](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md), which extends Van Clief and McDermott's *Interpretable Context Methodology* (arXiv:2603.16021) with a two-axes reframing (routing hierarchy and load pattern combined with content type) and adds a Completion field to stage contracts.

icm-kit is the applied counterpart: a tool that operationalizes the paper's classification and failure modes.

## Status: v1.0

`audit` and `init` both ship end-to-end. `audit` runs the §2.5 file classifier and the W1-W7 / F1-F9 rule set, validated against a real production workspace (the dry run against it drove the v0.2 to v0.5 hardening and surfaced the fork rules landing as v0.6+). v0.6 adds `F8` DUPLICATION, a whole-workspace check for the same prose in two routed homes; v0.7 adds `F9` SUPERSEDED_BUT_LIVE, flagging a live-routed file that opens with a superseded/deprecated banner; v0.8 adds `F7` KIT_BOILERPLATE, the first git-history rule, flagging a file inherited from the workspace's fork point and never adapted since: with it the failure-mode codes are now contiguous `F1` through `F9`; v0.9 normalizes `F3` STALE_CONTENT pointers (relative refs from a nested CLAUDE.md now resolve against the tree's normalized paths) and dedups `F3` to one finding per stale pointer. `init` (v0.15 to v1.0) generates the audit-green golden template: the normative §7 generation contract and the `src/templates/` byte tree, so a freshly scaffolded workspace audits to zero findings. v1.0 lands both tools end-to-end against the spec, validated against the production AIOS fork and a clean generated workspace. Typing agent *roles*, not just files (per the [agent-role topology](https://github.com/usebessemer/research/blob/main/theory/agent-role-topology.md)), is a forthcoming SPEC extension.

- [`SPEC.md`](SPEC.md): the formal model (v1.0), well-formedness rules, failure modes, and stage-contract requirements.

## Roadmap

- **v0.1 to v1.0** (shipped): the rule model, the §2.5 classifier, `audit`, and `init`, all hardened against a real production workspace. `init` now ships alongside `audit`: it generates the audit-green golden template, and both tools were validated against the production AIOS fork and a clean generated workspace.
- **next**: the role-layer SPEC extension (typing agent *roles*, not just files).

## Development

icm-kit is developed spec-driven. `SPEC.md` is the source of truth for behaviour. Any change that affects the classifier or its rules updates `SPEC.md` and the code in the same PR. If the spec is ambiguous or wrong, update the spec (or open an issue) before changing the code.

## License

MIT. See [LICENSE](LICENSE).
