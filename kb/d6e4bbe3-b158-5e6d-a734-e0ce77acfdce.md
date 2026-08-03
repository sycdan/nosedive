---
kind: command
id: d6e4bbe3-b158-5e6d-a734-e0ce77acfdce
name: preflight@1
gist: Install the bridge pre-push hook as a managed LF-only shim, never changing `core.hooksPath` or clobbering a foreign hook.
scopes: []
meta:
  usage: nosedive preflight
  agents-use-when: starting work in a bridge, to confirm the pre-push hook is installed.
  adapter: kb/artifacts/019fadf5-e087-7e53-b112-bb9402598e6b.mjs
  entrypoint: L1__preflight
---

# Preflight

Searches upward for the nearest bridge config and installs
`.git/hooks/pre-push` in that bridge's Git common directory.

The installed file is an LF-only executable shim: `#!/bin/sh`,
`# nosedive-managed`, and `exec npx nosedive _pre-push.hook "$@"`.

Re-running is idempotent: a managed hook is refreshed in place.

## What preflight will not touch

- Existing foreign hooks are left unchanged. Preflight warns on stderr and
  tells the user to add `npx nosedive _pre-push.hook "$@" || exit 1` to their
  existing hook setup; see
  [`_pre-push.hook`](9e3a676a-6d2f-5b93-93af-f4608ed28843.md).
- If `core.hooksPath` is set, preflight does not change Git config and does not
  write an ignored `.git/hooks/pre-push`; it prints the same manual wiring
  guidance.

Preflight only installs the hook. Config migrations are handled by
[`seed`](34c8e9fb-9629-5767-9a81-914f78c63b68.md); agent instruction files are
expected to be source-controlled files.
