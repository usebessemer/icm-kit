# Working conventions

How work is done in this workspace. These are the durable conventions the operator and the agents hold to; they are routed from the root, not baked into it.

## The audit

This workspace is structured against the Interpretable Context Methodology, and it stays well-formed only if it is checked. Run the audit from the workspace root:

```
icm-kit audit
```

Run it against a specific path with `icm-kit audit <path>`. A clean workspace reports no findings and exits zero; any finding exits non-zero, so the audit can gate a commit or a CI check. The pre-commit hook in [`.githooks/pre-commit`](.githooks/pre-commit) runs the same audit in warn mode: it reports findings but never blocks a commit.

## Altitude and routing

Keep the root thin. Knowledge lives in the file that serves it, and the root routes to that file rather than inlining it. When a section of any `CLAUDE.md` starts to carry standing knowledge, move the knowledge to a routed file and leave a link behind.

## Writing

- No em dashes in anything, drafted or committed. Use commas, colons, semicolons, or two short sentences.
- Nothing goes out under the operator's name without their approval on a shown draft. The workflow is in [`identity/email-workflow.md`](identity/email-workflow.md).

## Decisions

A decision worth keeping goes in [`decisions/log.md`](decisions/log.md) as a dated entry, newest last, with the reasoning attached. The log is append-only: supersede an entry with a later one rather than editing it in place.
