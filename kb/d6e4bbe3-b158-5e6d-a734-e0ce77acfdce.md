---
kind: command
id: d6e4bbe3-b158-5e6d-a734-e0ce77acfdce
name: preflight@1
gist: Confirm the bridge pre-push hook is wired, then print the session-start report -- bridge status, pilot identity, and open work.
scopes: []
meta:
  usage: nosedive preflight
  agents-use-when: you need to prepare the bridge for a work session or learn the current bridge state, pilot identity, or open work.
  adapter: kb/artifacts/019fadf5-e087-7e53-b112-bb9402598e6b.mjs
  entrypoint: L1__preflight
  agent-guidance:
    - 'If the pilot wants to work on something specific, start with `nosedive jump <doc-path>`.'
    - 'Otherwise, suggest they address something that has `needs`.'
    - 'If nothing needs to be done right now, start a free dive with `nosedive record.dive --free`, then help the pilot pitch a feat and record it on the dive.'
---

# Preflight

Call this before your first reply to the pilot in a session.

## Pre-push hook

Searches upward for the nearest bridge config and installs
`.git/hooks/pre-push` in that bridge's Git common directory.

The installed file is an LF-only executable shim: `#!/bin/sh`,
`# nosedive-managed`, and `exec npx nosedive _pre-push.hook "$@"`.

Re-running is idempotent: a managed hook is refreshed in place.

### What preflight will not touch

- A foreign hook, or a hook under `core.hooksPath`, that already invokes
  `_pre-push.hook` -- under any launcher, e.g. an aliased `nosedive`, a pinned
  `npx -y nosedive@<version>`, or `node dist/cli.js` -- is left unchanged and
  preflight continues silently.
- Existing foreign hooks with no such invocation are left unchanged, but
  preflight prints advice on stderr and **exits 1**: add
  `npx nosedive _pre-push.hook "$@" || exit 1` to the existing hook setup; see
  [`_pre-push.hook`](9e3a676a-6d2f-5b93-93af-f4608ed28843.md).
- If `core.hooksPath` is set, preflight never changes Git config and never
  writes an ignored `.git/hooks/pre-push`. If the hook under `core.hooksPath`
  doesn't invoke `_pre-push.hook` either, it prints the same advice and
  **exits 1**.

Config migrations are handled by [`seed`](34c8e9fb-9629-5767-9a81-914f78c63b68.md);
agent instruction files are expected to be source-controlled files.

## Session-start report

Once the hook is confirmed wired, preflight prints, to stdout:

```
== bridge status ==
nosedive-workspace: <absolute worktree path>/<workspace>
nosedive-current-dive-id: <uuid>
nosedive-current-dive-gist: <dive gist>
nosedive-current-effort: <uuid>

== pilot identification ==
nosedive-pilot-name: <git-config-name>
nosedive-pilot-email: <git-config-email>

== open work: current effort backlog ==
<backlog memo body>
```

`nosedive-workspace` is always posix-formatted (forward slashes, even on
Windows). The dive and effort lines are omitted together when
`<nosedive-workspace>/.nosedive-ref` names no active dive; if it does but the dive or its
effort can't be resolved, whatever did resolve is still printed and the reason
goes to stderr. The backlog section behaves the same way: if the bridge has no
resolvable backlog memo, the header still prints, the reason goes to stderr,
and preflight still exits 0.

Pilot identity is the same fields [`whoami`](a40303c1-1362-523f-b095-49178354f878.md)
prints, from the same source: missing `user.name`/`user.email` in git config
fails preflight (stderr, exit 1) the same way it fails `whoami`.
