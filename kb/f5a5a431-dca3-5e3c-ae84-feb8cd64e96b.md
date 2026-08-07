---
kind: command
id: f5a5a431-dca3-5e3c-ae84-feb8cd64e96b
name: update-backlog@2
gist: Regenerate the configured backlog memo from bridge KB feat docs.
scopes: []
meta:
  usage: nosedive update-backlog
  agents-use-when: feat docs changed and the backlog memo must be regenerated to match.
  adapter: kb/artifacts/019fda66-c9df-7f70-ad8f-f766879067d7.mjs
  entrypoint: L2__updateBacklog
links:
  - kb/eb6305b4-9aa6-5fdb-b622-e0d17b6303bb.md:
      rel: supersedes
---

# Update backlog

Regenerates the bridge KB memo configured as `backlog:` in
`.nosedive/config.yaml`.

At L1, `backlog:` is the UUID of the memo that indexes current work. This
command scans bridge `kind: feat` docs, rebuilds `rel: main-feat`
frontmatter links with bridge-root POSIX paths such as `kb/<id>.md`, and
rewrites the memo body with normal relative markdown links such as `<id>.md`.

Feat `name` slug chains provide the display structure. A top-level segment
with no matching feat doc is rendered as a grouping heading.
