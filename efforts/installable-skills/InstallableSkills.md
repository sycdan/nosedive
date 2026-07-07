---
effort: installable-skills
status: planned
---

# Installable Skills

## Goal

Make nosedive a distribution vehicle for agent skills. Skills are authored once
in this repo (in a knowledge base directory, `kb/`) and can be installed into
any project by running `nosedive install-skill`, which materializes them in the
layout the target harness expects (e.g. `.claude/skills/<slug>/SKILL.md` for
Claude Code).

## Why

We want to build skills in this project (dogfooding) and carry them to other
projects without copy-paste drift. The kb file is the single source of truth;
`nosedive install-skill` is the sync mechanism.

## Scope

This effort owns one child effort, plus a dependency on the shared kb format:

- [install-skill](install-skill/InstallSkill.md) — the
  `nosedive install-skill` CLI command that scans `kb/`, finds installable
  skills, and installs them per target harness. Harnesses are auto-detected
  from marker files (`CLAUDE.md`, `.github/copilot-instructions.md`) or given
  explicitly via `--harness`. Supports `claude` and `copilot` to start.

The document format both consume is the top-level
[kb-store](../kb-store/KbStore.md) effort. The first skill shipped through this
pipeline is [workon](../workon/Workon.md).

## Acceptance

- A skill authored in `kb/<uuid>.md` in this repo can be installed into a
  fresh project by running `nosedive install-skill --harness claude` in that
  project's root, producing `.claude/skills/<slug>/SKILL.md`.
- Re-running install is idempotent (overwrites with latest content).
