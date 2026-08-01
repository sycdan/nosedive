---
kind: command
id: aedefdbd-4d61-5bdb-bc9b-b48abbfd3760
name: seed@0
gist: Create, migrate, or edit bridge config in the current directory; every run first migrates an out-of-date bridge to the latest compatibility level.
scopes: []
meta:
  usage: nosedive seed [--headless]
  adapter: kb/artifacts/019fadf5-e083-714e-a4c8-dd6a1d480e2c.mjs
  entrypoint: L0__seed
---

# Seed

Bridge config is stored in `.nosedive/config.yaml`. It is checked into git and
team-shared, and carries `workspace`, `backlog`, `kb`, `home-branch`,
`work-branch-prefix`, `agents`, and a `compatibility-level`. Its presence in a
directory is what identifies that repo as a bridge.

[`Pilot identity`](a40303c1-1362-523f-b095-49178354f878.md) is not stored in bridge config.

`seed` also writes `.nosedive/.gitignore` every run, to keep nosedive internals out of the working tree.

## Migration

Every run first migrates an out-of-date bridge to the latest compatibility
level. For L1, that means the legacy single-file `.nosediverc` shape and
unconfigured notes repos with legacy `backlog/` or `efforts/` content are
migrated by [`seed-L1-bridge`](019f916b-f800-723d-b096-07d4300ff28a.md)
before prompting or writing. Already-current bridges are a cheap no-op, so
`seed --headless` is safe to run at the start of every agent session.

If both `.nosediverc` and `.nosedive/config.yaml` exist, `seed` refuses to
guess which config is authoritative and asks the pilot to remove `.nosediverc`
manually. A migration also refuses to write when managed migration paths are
dirty, so the pilot can review or revert migration output with ordinary git
tools.

## Prompting

Without `--headless`, `seed` prompts for workspace, backlog, kb, home branch,
work branch prefix, and `agents`; existing values (or defaults) are shown and
kept by pressing Enter. `agents` defaults to `copilot`, with `claude` as an
optional additional target.

`--headless` skips all prompts, keeping existing values or configured
defaults.

## Not seeded

`seed` does not copy packaged docs into the bridge KB. Agent instruction files
are expected to be managed by nosedive as ordinary files that can be reviewed
and checked into source control.
