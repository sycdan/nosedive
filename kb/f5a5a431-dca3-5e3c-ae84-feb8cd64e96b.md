---
kind: command
id: f5a5a431-dca3-5e3c-ae84-feb8cd64e96b
name: update-backlog@2
gist: Rerender the configured backlog memo body from the memo's own feat links.
scopes: []
meta:
  usage: nosedive update-backlog [--inject <ref>]...
  agents-use-when: a feat linked from the backlog changed, or a feat must be added to the backlog.
  adapter: kb/artifacts/019fda66-c9df-7f70-ad8f-f766879067d7.mjs
  entrypoint: L2__updateBacklog
links:
  - kb/eb6305b4-9aa6-5fdb-b622-e0d17b6303bb.md:
      rel: supersedes
---

# Update backlog

Rerenders the body of the bridge KB memo configured as `backlog:` in
`.nosedive/config.yaml`. The memo's own links are the input: nothing is
discovered by scanning the KB for a kind, so a feat appears on the backlog
because somebody linked it, not because of what it is called.

The top level is exactly the memo's links whose rel names a feat-like role.
The rel's predicate becomes the section heading, so `rel: current.feat` renders
its target under `## Current` and `rel: future.feat` renders its target under
`## Future`. Sections are ordered alphabetically, entries within a section by
title. The legacy `<predicate>-effort` spelling is read as the same edge and is
never rewritten.

Below the top level, a node's children are its own `rel: child.feat` links and
nothing else. `child.feat` is the only edge that means open work. Every other
predicate on a `.feat` edge is reference -- it records a relation without
claiming the target is open -- so `rel: closed.feat` takes finished work off the
backlog while keeping the link that says where it belonged.

Nothing is discovered by pointing back. A doc carrying `rel: parent.feat` says
where it sits, not that it is open, and is never rendered on that account. This
is what makes the backlog editable: the node holding the edge is the one that
can close it, and a child cannot re-open itself by describing its own parent.
`pitch --parent` writes both directions, so a pitched feat still renders under
its parent with no further step.

`--inject <ref>` appends a `rel: injected.feat` link for the named doc, which
renders it under `## Injected`. This is how a feat pitched with no parent
reaches the backlog. The flag repeats, takes a quid or a bridge-relative KB
path, and is a no-op when the memo already links that doc as work -- an
existing rel is the pilot's own filing and is never rewritten to match the flag.

Frontmatter is otherwise preserved as written. Only `scopes:` is recomputed, as
the union of the scopes of the docs actually rendered; a repo that stays in that
set keeps every key already written on it, including `note:`.

A link naming a doc that does not exist, or naming a `kind: dive` or
`kind: repo` doc, fails and says which link did it.
