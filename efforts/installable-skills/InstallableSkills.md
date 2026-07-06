---
effort: installable-skills
status: planned
---

# Installable Skills

## Goal

Make nosedive a distribution vehicle for agent skills. Skills are authored once
in this repo (in a knowledge base directory, `kb/`) and can be installed into
any project by running `nosedive install-skill`, which materializes them in the
layout the target harness expects (e.g. `.claude/skills/<name>/SKILL.md` for
Claude Code).

## Why

We want to build skills in this project (dogfooding) and carry them to other
projects without copy-paste drift. The kb file is the single source of truth;
`nosedive install-skill` is the sync mechanism.

## Scope

This is a parent effort. The work is split into two child efforts:

- [kb-store](kb-store/KbStore.md) — the `kb/` directory format: uuid7-named
  markdown files with frontmatter that identifies a document as a
  user-installable skill and describes how to install it.
- [install-command](install-command/InstallCommand.md) — the
  `nosedive install-skill` CLI command that scans `kb/`, finds installable
  skills, and installs them according to frontmatter + CLI args
  (e.g. `--harness claude`).

The first skill shipped through this pipeline is [workon](../workon/Workon.md).

## Acceptance

- A skill authored in `kb/<uuid7>.md` in this repo can be installed into a
  fresh project by running `nosedive install-skill --harness claude` in that
  project's root, producing `.claude/skills/<name>/SKILL.md`.
- Re-running install is idempotent (overwrites with latest content).
