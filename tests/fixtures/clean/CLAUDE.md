# Clean sample workspace

Identity and conventions for a well-formed ICM workspace. This file exists to
exercise every row of the SPEC §2.5 classification table.

Work products live under `projects/`. The deploy runbook is `runbook.md`,
loaded on demand for deploy tasks.

## Load/skip table

| Task   | Load         | Skip       |
| ------ | ------------ | ---------- |
| deploy | runbook.md   | context/   |
| triage | references/  | projects/  |
