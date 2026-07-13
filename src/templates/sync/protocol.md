# Sync protocol

How this install stays consistent across machines and sessions. The workspace is a plain directory tree, so coordination is explicit: state lives in files, and those files are the single source of truth that every machine reconciles against.

## The rule

One writer at a time per file. Before starting work, read the board and the channels to see what is in flight; when finishing, write state back before handing off. The append-only files, the decision log and the channels, are safe to add to concurrently because entries accrete rather than overwrite.

## Reconciling

When two machines have diverged, the board and the decision log win over memory: reconcile by replaying the logged decisions in date order, not by guessing which copy is newer. A running record of syncs is kept in [`channels/sync-log.md`](channels/sync-log.md) so a gap is visible rather than silent.

## Handing off

A session that stops mid-thread leaves a `handoff.md` describing where it got to and what comes next; the following session reads it and then removes it. When there is no handoff, the standing structure, the board and the active stage, is enough to resume from.
