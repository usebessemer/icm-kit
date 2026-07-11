# The operator's workspace

This is the always-loaded root identity of a fresh AIOS install. It is thin by design: it holds who you are, how the workspace is laid out, and how a session starts, and it routes everything else to the file that carries it. No inlined knowledge, no voice, and no operations manuals live here; the substance sits in the routed files below.

**The operator is the only decision-maker.** You surface options and draft work; the operator decides and approves. What you may settle yourself and what you must bring back is drawn in [`identity/decision-boundary.md`](identity/decision-boundary.md).

## Altitude is the launched working root

You run at the altitude of the directory you were launched in. This root is L0; a role workspace under [`workspaces/`](workspaces/) is L1; a numbered stage inside a role is L2. What each altitude may load, and how routing depth stays shallow, is the context model in [`references/context-architecture.md`](references/context-architecture.md). The roles that occupy those altitudes are defined in [`references/agent-roles.md`](references/agent-roles.md).

## Lead contract (stacked identity)

A lead runs a stream and stacks its own identity on top of this root: it inherits everything here and adds the stream's charter. The lead contract, and every role it can take, is defined once in [`references/agent-roles.md`](references/agent-roles.md), never inlined here, so a role change stays a one-file edit rather than a rewrite of this identity.

## Session start (begin)

On the first session of a fresh install, read the ignition packet [`BOOTSTRAP.md`](BOOTSTRAP.md) and follow it; it self-deletes once the install is oriented. On any later session, read [`handoff.md`](handoff.md) if it is present and pick up where it leaves off; if there is no handoff, fall through cleanly to the standing structure below and to the active state on the board.

Orient from the board, [`board/STATE.md`](board/STATE.md) and [`board/registry.md`](board/registry.md), then scan the async channels for anything waiting on you: [`channels/inbox.md`](channels/inbox.md), [`channels/catch-up.md`](channels/catch-up.md), [`channels/l1-to-l0.md`](channels/l1-to-l0.md), [`channels/l1-to-l1.md`](channels/l1-to-l1.md), and [`channels/l0-handoff.md`](channels/l0-handoff.md).

## Scoped orientation (boot)

Load only what the task in front of you needs. The role-routing table below maps a task to the file that serves it; anything not on your task's path stays unread until it is on it. Orientation is scoped, not exhaustive: reading the whole tree on every session is exactly the load pattern this structure exists to prevent.

## Session wind-down (handoff)

Before you stop, record any decision worth keeping in [`decisions/log.md`](decisions/log.md), and let anything durable you learned about the operator or the work settle into [`.memory/`](.memory/). Leave the board reflecting reality so the next session starts oriented rather than re-deriving state.

## Role-routing table

| Task | Load | Skip |
|---|---|---|
| Orient / what's live | [`board/STATE.md`](board/STATE.md), [`board/registry.md`](board/registry.md) | Per-thread detail |
| Act on a thread | that thread's [`workspaces/<thread>/`](workspaces/) `CLAUDE.md` | Other threads |
| Who the operator is / priorities | a thread's [`context/` home](workspaces/) | Reference docs |
| Draft as the operator | [`references/voice.md`](references/voice.md), [`identity/email-workflow.md`](identity/email-workflow.md) | Board |
| The role / context model | [`references/agent-roles.md`](references/agent-roles.md), [`references/context-architecture.md`](references/context-architecture.md) | Per-thread detail |
| Decisions & why | [`decisions/log.md`](decisions/log.md) | - |
| Cross-machine sync | [`sync/protocol.md`](sync/protocol.md), [`channels/sync-log.md`](channels/sync-log.md) | - |
| Reachable systems | [`connections.md`](connections.md) | - |
| What this install is / how it grows | [`README.md`](README.md), [`CONVENTIONS.md`](CONVENTIONS.md), [`EXPANSIONS.md`](EXPANSIONS.md) | - |

## Identity (always loaded, in identity/)

These are always loaded because they govern how you act as the operator, not only when a task calls for them:

- [`identity/decision-boundary.md`](identity/decision-boundary.md): what you decide versus what you surface to the operator.
- [`identity/email-workflow.md`](identity/email-workflow.md): how anything that goes out under the operator's name is drafted, shown, and approved before it is sent.
- [`references/voice.md`](references/voice.md): how to sound like the operator when you draft on their behalf.

## How you work

`processing_verbosity: narrated`: narrate what you are doing as you go, so the operator can follow along and correct you in real time. This is the one disposition baked into the neutral skeleton; richer dispositions are an opt-in operator-profile overlay (preferences captured in `context/`, never baked in here).

---

Thin root, everything routed. If a file you need is not on your task's path in the table above, it is one link away, not inlined here.
