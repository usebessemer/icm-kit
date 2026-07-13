# This install

A fresh AIOS workspace: an interpretable-context home for one operator and the agents that work on their behalf. The always-loaded root identity is [`CLAUDE.md`](CLAUDE.md); start there. This file is the human-facing orientation to what lives where.

## The shape

- [`CLAUDE.md`](CLAUDE.md): the thin root identity, the role-routing table, and the session-start handshake.
- [`board/`](board/STATE.md): the active-state board, what is live right now.
- [`decisions/`](decisions/log.md): the append-only log of decisions and why they were made.
- [`sync/`](sync/protocol.md) and [`channels/`](channels/inbox.md): cross-machine coordination and the async channels between altitudes.
- [`identity/`](identity/decision-boundary.md): the load-bearing identity files, the decision boundary and the outbound-comms workflow.
- [`references/`](references/agent-roles.md): the on-demand reference library, loaded by task, not by default.
- [`connections.md`](connections.md): the registry of external systems this install can reach.
- [`workspaces/`](workspaces/): role workspaces; empty until a role is added.

## Growing it

This is the role-less default. How to add a role, a channel, or a stage contract is documented in [`EXPANSIONS.md`](EXPANSIONS.md). The working conventions, including how to run the audit, are in [`CONVENTIONS.md`](CONVENTIONS.md).

The workspace is not a git repository yet: `init` deliberately does not run `git init`. Initialising git is the operator's first act, and from that point the workspace's own history is what the audit reads.
