# Ignition

This is the one-shot ignition packet for a fresh install. It runs once, on the very first session, to orient the workspace to its operator, and then it removes itself. If you are reading it, the install has not been ignited yet.

## What this session is for

The generated workspace is neutral: it knows the ICM shape but nothing about the operator it now belongs to. This first session fills in the minimum needed to make it theirs, working with the operator rather than guessing on their behalf. Nothing here is decided for them; everything is proposed and confirmed.

## The handshake

Walk the operator through the workspace and settle four things with them, in their own words:

1. Who they are and what the workspace is chiefly for, captured into a `context/` home so later sessions start oriented.
2. Which external systems the workspace should reach, recorded in [`connections.md`](connections.md) as each one is wired.
3. How they want outbound drafts handled, confirmed against [`identity/email-workflow.md`](identity/email-workflow.md).
4. Whether a first role is worth standing up now or later, following [`EXPANSIONS.md`](EXPANSIONS.md) if so.

Take these one at a time, and record what the operator settles into the file that owns it rather than back into this packet.

## Winding down

Once the four are settled, note the outcome on [`board/STATE.md`](board/STATE.md) and log any real decision in [`decisions/log.md`](decisions/log.md). Then delete this file: the workspace is ignited, and later sessions begin from the root's session-start handshake, not from here. Leaving the packet in place after ignition is the one thing to avoid, since it re-runs an orientation the workspace no longer needs.
