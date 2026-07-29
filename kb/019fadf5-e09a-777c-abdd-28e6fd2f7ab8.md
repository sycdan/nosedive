---
kind: contract
id: 019fadf5-e09a-777c-abdd-28e6fd2f7ab8
name: apply@1
gist: "Deprecated; no longer writes agent instruction files. Only `--dry-run` remains, as a read-only inspection path."
scopes: []
links:
  - artifacts/019fadf5-e09b-74e4-a26e-81698df2ea8a.mjs:
      rel: executor
---

Usage: nosedive apply
  Deprecated: agent instruction files are now expected to be checked into source control.

# Apply

Deprecated.

`apply` no longer writes agent instruction files. Running it without
`--dry-run` exits nonzero with
`nosedive apply is deprecated; check agent instruction files into source control instead`.

`--dry-run` remains as a read-only inspection path for now. It prints a
deprecation warning on stderr, then reports the resolved bridge, workspace,
backlog, kb, home branch, work branch prefix, pilot, effort, dive, tags,
bridge doc targets, scoped repos, and any warnings, and ends with
`No files written.`
