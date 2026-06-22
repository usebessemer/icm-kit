# icm-kit

Tooling for the Interpretable Context Methodology (ICM), an architecture for organizing the folders and files an agent reads. icm-kit provides two commands sharing a single rule model:

- **`audit`** (implemented): check an existing workspace against the rule model and report violations of the ICM failure modes.
- **`init`** (next): scaffold a new ICM-compliant workspace.

## Background

ICM is described in [*Context as Architecture*](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md), which extends Van Clief and McDermott's *Interpretable Context Methodology* (arXiv:2603.16021) with a two-axes reframing (routing hierarchy and load pattern combined with content type) and adds a Completion field to stage contracts.

icm-kit is the applied counterpart: a tool that operationalizes the paper's classification and failure modes.

## Status: v0.6

`audit` is implemented and hardened: the §2.5 file classifier and the W1-W7 / F1-F6 rule set, run end-to-end and validated against a real production workspace (the dry run against it drove the v0.2 to v0.5 hardening and surfaced the fork rules now landing as v0.6+). v0.6 adds `F8` DUPLICATION, a whole-workspace check for the same prose in two routed homes; `F7` KIT_BOILERPLATE and `F9` SUPERSEDED_BUT_LIVE land next (`F7` is reserved, so the codes are briefly non-contiguous). `init` follows. Typing agent *roles*, not just files (per the [agent-role topology](https://github.com/usebessemer/research/blob/main/theory/agent-role-topology.md)), is a forthcoming SPEC extension.

- [`SPEC.md`](SPEC.md): the formal model (v0.6), well-formedness rules, failure modes, and stage-contract requirements.

## Roadmap

- **v0.1 to v0.6** (shipped): the rule model, the §2.5 classifier, and `audit`, hardened against a real production workspace.
- **next**: `init` (scaffold a compliant workspace), then the role-layer SPEC extension.
- **1.0**: both `init` and `audit` shipping end-to-end against the spec, with a clean generated workspace auditing green.

## Development

icm-kit is developed spec-driven. `SPEC.md` is the source of truth for behaviour. Any change that affects the classifier or its rules updates `SPEC.md` and the code in the same PR. If the spec is ambiguous or wrong, update the spec (or open an issue) before changing the code.

## License

MIT. See [LICENSE](LICENSE).
