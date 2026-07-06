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
  - [install-skill](efforts/installable-skills/install-skill/InstallSkill.md) —
    planned. `nosedive install-skill` scans `kb/` and installs skills per
    harness. Auto-detects harnesses from marker files (`CLAUDE.md`,
    `.github/copilot-instructions.md`) or takes explicit `--harness`; fails if
    none. Supports `claude` and `copilot`. Always overwrites (no `--force`).
- [workon](efforts/workon/Workon.md) — planned. The `nosedive-workon` skill:
  locate effort, ensure submodules, create gitignored session with per-repo
  worktrees (writable ones on `nosedive/session/<name>` branches), run
  subagent against `prompt.md`, then user accepts (merge to
  `nosedive/effort/<chain>`, artifacts land in effort `.artifacts/`) or
  abandons; cleanup either way.

