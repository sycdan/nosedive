---
effort: kb-store
status: in-progress
---

# KB Store

## Goal

Define the `kb/` directory at the repo root as nosedive's knowledge base: a
flat store of markdown documents named `<uuid>.md`, each self-describing via
frontmatter. Documents whose frontmatter marks them as user-installable skills
are what `nosedive install-skill` picks up.

## Design

The canonical format spec lives in [`kb/README.md`](../../kb/README.md) — it
ships with the store. This section records the decisions behind it.

- **Filenames are UUIDv7.** Time-ordered, so a directory listing roughly
  follows creation order. The uuid is the document's stable identity;
  human-readable identity lives in frontmatter (`slug`). See the
  [uuid standard](../../kb/019f39d7-f914-7b40-8e9c-2c53a827b492.md).
- **Frontmatter is the schema; body is content.** For `kind: skill` the body
  is the SKILL.md body verbatim; the harness-specific frontmatter (e.g.
  Claude's `name`/`description`) is generated at install time from the kb
  frontmatter, never stored in the body.
- **The kb is a general store, not just skills.** A `kind:` other than `skill`
  is allowed and ignored by `install-skill`. `kind: placeholder` is the first
  such kind: it defines a metasyntactic `<token>` once (grep-addressable by
  `slug`) instead of letting the definition drift across consumers.

## Tasks

- [x] Create `kb/` directory with a short `kb/README.md` describing the format.
- [x] Decide + document the frontmatter schema: common fields +
      `kind: skill` / `kind: placeholder`, documented in `kb/README.md`.
- [x] Standardize uuid generation on a tool (`npx uuidv7`); never hand-roll.
      (Whether install tooling shells out or takes a dev dependency is
      deferred to
      [install-skill](../installable-skills/install-skill/InstallSkill.md) as
      an implementation detail.)

Remaining for acceptance: a valid `kind: skill` document, delivered by the
[workon](../workon/Workon.md) effort.

## Acceptance

- Format documented in `kb/README.md`.
- At least one valid skill document exists (delivered by the
  [workon](../workon/Workon.md) effort).
