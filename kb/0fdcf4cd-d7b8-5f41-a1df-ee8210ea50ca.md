---
kind: command
id: 0fdcf4cd-d7b8-5f41-a1df-ee8210ea50ca
name: add-repo@0
gist: "Deprecated; use `add-repo.effort`, which writes repo scopes onto L1 KB effort docs."
scopes: []
meta:
  usage: nosedive add-repo <repo-id-or-name> [--effort <effort>] [--ref <ref>] [--read-only] [--apply]
  adapter: kb/artifacts/019fadf5-e095-73c0-aa47-ef052ed2e7e6.mjs
  entrypoint: L0__addRepo
links:
  - kb/019f916b-f800-723d-b096-07d4300ff28a.md:
      rel: deprecated-by
---

# Add repo

Deprecated. Use `add-repo.effort` in compatibility-level 1 bridges.

Resolves `<repo-id-or-name>` against the bridge kb by `kind: repo` `id` or
exact `name`, then appends it to the target effort's repo list.

- `--effort` chooses the target effort; without it the active effort is used.
- `--ref` pins the repo entry to a ref instead of the repo's base branch.
- `--read-only` records the entry as a read-only scope.
- `--apply` regenerates bridge agent docs, but only when the target effort is
  the active one. Against a non-active effort it prints
  `Generated docs not updated because the target effort is not active.` and
  writes nothing.
