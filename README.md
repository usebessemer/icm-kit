# icm-kit

Tooling for the Interpretable Context Methodology (ICM), an architecture for organizing the folders and files an agent reads. icm-kit will provide two commands sharing a single rule model:

- **`init`**: scaffold a new ICM-compliant workspace.
- **`audit`**: check an existing workspace against the rule model and report violations of the ICM failure modes.

## Background

ICM is described in [*Context as Architecture*](https://github.com/usebessemer/research/blob/main/theory/context-as-architecture.md), which extends Van Clief and McDermott's *Interpretable Context Methodology* (arXiv:2603.16021) with a two-axes reframing (routing hierarchy and load pattern combined with content type) and adds a Completion field to stage contracts.

icm-kit is the applied counterpart: a tool that operationalizes the paper's classification and failure modes.

## Status: v0.1

This repo contains the **specification only**. No commands are implemented yet. The spec is the shared contract that `init` and `audit` will both consume.

- [`SPEC.md`](SPEC.md): the formal model, well-formedness rules, failure modes, and stage-contract requirements.

## Roadmap

- **v0.1**: spec only (this release).
- **v0.x**: rule model implementation, then `init`, then `audit`.
- **1.0**: both commands shipping end-to-end against the spec, audited against a real production workspace.

## License

MIT. See [LICENSE](LICENSE).
