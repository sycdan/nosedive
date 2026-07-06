# CLAUDE

## Backlog

The canonical backlog is stored in `efforts/` on the `main` branch. Each efforts
is in its own folder, and they can be nested, e.g.
`<parent-effort-slug>/<child-effort-slug>/<grandchild-effort-slug>`.

Each effort folder contains a file named `<EffortName>.md`, matching its slug
but in PascalCase.

A summary of the current efforts should be kept in `CLAUDE.md` and updated as
efforts go through their lifecycle.

### Current efforts

- [installable-skills](efforts/installable-skills/InstallableSkills.md) —
  planned. Ship agent skills from this repo's `kb/` store into other projects
  via `nosedive install-skill`.
  - [kb-store](efforts/installable-skills/kb-store/KbStore.md) — planned.
    `kb/` directory format: `<uuid7>.md` docs with frontmatter marking
    user-installable skills.
  - [install-command](efforts/installable-skills/install-command/InstallCommand.md) —
    planned. `nosedive install-skill --harness claude` scans `kb/` and writes
    `.claude/skills/<name>/SKILL.md` in the cwd.
- [workon](efforts/workon/Workon.md) — planned. The `nosedive-workon` skill:
  locate effort, ensure submodules, craft prompt artifact, create session, run
  subagent, collect output artifact.

