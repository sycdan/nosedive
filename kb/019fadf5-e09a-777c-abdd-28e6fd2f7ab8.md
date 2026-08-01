---
kind: command
id: 019fadf5-e09a-777c-abdd-28e6fd2f7ab8
name: apply@0
gist: Deprecated; no longer writes agent instruction files. Only `--dry-run` remains, as a read-only inspection path.
scopes: []
meta:
  usage: nosedive apply
  processors:
    - kb/artifacts/019fadf5-e09b-74e4-a26e-81698df2ea8a.mjs
links:
  - 019f916b-f800-723d-b096-07d4300ff28a:
      rel: deprecated-by
---

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
