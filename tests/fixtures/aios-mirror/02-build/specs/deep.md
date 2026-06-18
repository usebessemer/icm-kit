# Nested build spec

A working artifact of the build stage that lives one level deeper, in the
stage's `specs/` subfolder. It routes working / per_item at L2 via the broadened
stage-working-file row: its grandparent `02-build` is a numbered stage, even
though its immediate parent `specs` is not. Before the broadening it would have
fallen through to Hidden context.
