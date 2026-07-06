---
effort: install-skill
parent: installable-skills
status: planned
---

# Install Skill

## Goal

Add `nosedive install-skill` to the CLI. It scans the nosedive package's `kb/`
directory for documents with `kind: skill` frontmatter and installs each into
the current working directory in the layout each target harness expects.

## CLI contract

```
nosedive install-skill [--harness <name>]... [--skill <name>]
```

- `--harness <name>` (optional, repeatable) — explicit install targets.
  Supported values to start: `claude`, `copilot`. When omitted, auto-detect
  (see below).
- `--skill <name>` (optional) — install only the named skill; default installs
  all skills whose `harnesses` frontmatter includes each target harness.
- Idempotent: re-running always overwrites installed files with current kb
  content. Install paths use names specific to this app, so overwrite is safe;
  no `--force` flag.

## Harness selection

- If one or more `--harness` given: install for exactly those.
- If none given: auto-detect harnesses in the cwd by their marker files:
  - `claude` — `CLAUDE.md` present.
  - `copilot` — `.github/copilot-instructions.md` present.
  - Install for every detected harness.
- If no `--harness` given and none detected: fail with a clear error telling
  the user to pass `--harness`.

## Harness targets

- `claude` — `.claude/skills/<name>/SKILL.md` under the cwd, invocable as
  `/<name>` in Claude Code.
- `copilot` — install to the layout GitHub Copilot expects (confirm exact path
  during implementation, e.g. under `.github/`).

## Behavior

1. Resolve `kb/` relative to the installed nosedive package (it ships in the
   npm package — add `kb` to `files` in package.json).
2. Resolve target harnesses (explicit `--harness` or auto-detect; fail if none).
3. Parse frontmatter of each `kb/*.md`; select `kind: skill` documents
   matching each target harness (and `--skill` filter if given).
4. For each harness × skill: write the harness-specific file in the cwd,
   generating that harness's skill frontmatter from kb frontmatter, body
   copied verbatim.
5. Print a summary of what was installed and where (per harness).

## Tasks

- [ ] Frontmatter parsing (hand-rolled minimal YAML subset or small dep —
      decide during implementation; repo currently has zero runtime deps).
- [ ] Argument parsing for the new subcommand (extend the existing `switch` in
      `src/nosedive.ts` or introduce a tiny command router).
- [ ] Ship `kb/` in the npm package; verify resolution works both from a
      global/dep install and from the repo itself (dogfooding).
- [ ] Update USAGE text and README.
- [ ] Smoke test: run install in a temp dir, assert SKILL.md exists with
      expected frontmatter.

## Dependencies

- [kb-store](../../kb-store/KbStore.md) defines the format this command
  consumes.

## Acceptance

- `nosedive install-skill --harness claude` in an empty directory produces
  `.claude/skills/nosedive-workon/SKILL.md` (once the workon skill document
  exists in kb).
- In a project with both `CLAUDE.md` and `.github/copilot-instructions.md`,
  `nosedive install-skill` (no `--harness`) installs for both.
- In a project with no harness markers, `nosedive install-skill` (no
  `--harness`) fails with a clear error asking for `--harness`.
- Unknown harness values fail with a clear error listing supported harnesses.
