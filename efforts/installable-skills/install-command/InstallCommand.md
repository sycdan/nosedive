---
effort: install-command
parent: installable-skills
status: planned
---

# Install Command

## Goal

Add `nosedive install-skill` to the CLI. It scans the nosedive package's `kb/`
directory for documents with `kind: skill` frontmatter and installs each into
the current working directory in the layout the requested harness expects.

## CLI contract

```
nosedive install-skill --harness claude [--skill <name>] [--force]
```

- `--harness claude` (required for now; only supported value) — install target
  is `.claude/skills/<name>/SKILL.md` under the cwd, making the skill
  invocable as `/<name>` in Claude Code.
- `--skill <name>` (optional) — install only the named skill; default installs
  all skills whose `harnesses` frontmatter includes the requested harness.
- Idempotent: re-running overwrites installed files with current kb content.
  `--force` reserved for future conflict handling (e.g. locally modified
  SKILL.md); initial version may simply always overwrite.

## Behavior

1. Resolve `kb/` relative to the installed nosedive package (it ships in the
   npm package — add `kb` to `files` in package.json).
2. Parse frontmatter of each `kb/*.md`; select `kind: skill` documents
   matching the harness (and `--skill` filter if given).
3. For each: write `.claude/skills/<name>/SKILL.md` in the cwd, generating
   Claude skill frontmatter (`name`, `description`) from kb frontmatter, body
   copied verbatim.
4. Print a summary of what was installed and where.

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

- [kb-store](../kb-store/KbStore.md) defines the format this command consumes.

## Acceptance

- `nosedive install-skill --harness claude` in an empty directory produces
  `.claude/skills/nosedive-workon/SKILL.md` (once the workon skill document
  exists in kb).
- Unknown harness values fail with a clear error listing supported harnesses.
