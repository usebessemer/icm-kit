# Growing the workspace

The generated workspace is the role-less default: the minimal shape that audits clean. It grows by opt-in expansion, one addition at a time. Each expansion below keeps the workspace well-formed; re-run `icm-kit audit` after any of them.

## Add a role

A role is an L1 workspace under [`workspaces/`](workspaces/). Create `workspaces/<role>/` with two things and nothing else:

- a `CLAUDE.md` charter: the role's stacked identity, following the same session-start handshake as the root.
- a `context/` home for the role's situational files.

Do not pre-build empty `references/` or `.claude/skills/` levels for a role; add them only when the role needs them. A role sits at routing depth 2, well under the limit of 3. The role definitions themselves live in [`references/agent-roles.md`](references/agent-roles.md).

## Add a channel

The async channels between altitudes live in [`channels/`](channels/inbox.md). Add a channel as a new Markdown file there, then link it from the root session-start section so the reachability closure routes it. A channel is an append-only file: new messages go at the end.

## Add a stage contract

Task-level work at L2 is organised into numbered stage folders, `NN-name/`, each holding a `CONTEXT.md` stage contract. A stage contract carries four sections, Input, Process, Output, and Completion, each with real content. Work products for the stage live alongside it under the same numbered folder.

## Add an operator profile

The neutral skeleton bakes in no voice or dispositions. An operator profile is an opt-in overlay applied after generation: it fills [`references/voice.md`](references/voice.md) from the operator's real drafts and captures their preferences in a `context/` home. Until then the workspace stays behaviourally neutral and identical for every operator.
