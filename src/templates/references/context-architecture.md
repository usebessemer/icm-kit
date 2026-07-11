# Context architecture

A short primer on the Interpretable Context Methodology that shapes this workspace. The idea is that context is architecture: what an agent loads, and when, is a structural property of the workspace, not an afterthought. A well-formed workspace routes the right context to the right task and leaves everything else unread. The roles that work within this structure are in [`agent-roles.md`](agent-roles.md).

## Altitude

Every file sits at a routing level. L0 is the root: the always-loaded identity of the whole install. L1 is a nested workspace with its own root, a stream with its own charter. L2 is task-level structure inside a workspace, a numbered stage and its contract. Altitude is set by where a session is launched, and routing depth is kept shallow on purpose: a file more than a few levels from the root it serves is a signal that the structure has drifted.

## Content types

A file carries one kind of content. Identity is who the agent is and how it acts, always loaded. Situational is the current state of the world, also always loaded at its level. Reference is durable knowledge loaded on demand, only when a task calls for it. Working content is the per-item product of a specific task, loaded only when that item is the target. Keeping these separate is what lets a session load exactly what it needs.

## Load patterns

The when of a file follows its type. Always-loaded content is read on every session at its level, so it must stay small. On-demand content, like this primer, is pulled in by task type and can be as deep as it needs to be because it is not paid for on every session. Per-item content is touched only when its own work item is in hand. A file whose real load pattern does not match its type is misplaced, and the audit flags it.

## Why the root stays thin

The root is read on every single session, so every token in it is a tax on every session. That is why the root routes instead of inlines: it names the file that holds a thing and trusts the reader to follow the link when the task needs it. Knowledge lives at the altitude that uses it, reference material lives in the on-demand library, and the root stays a thin map. This is the whole discipline in one line: put each thing where it is loaded, and route to it from where it is looked for.
