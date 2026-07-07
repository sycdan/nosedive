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

- Files are named by UUIDv7 (time-ordered, so directory listing roughly follows
  creation order). The uuid is the document's stable identity; human-readable
  identity lives in frontmatter.
- Frontmatter schema (initial, for skill documents):

  ```yaml
  ---
  id: <uuid>            # matches filename
  kind: skill            # marks document as user-installable skill
  slug: nosedive-workon  # install slug; becomes the skill directory name
  description: >-        # one-liner used as the skill's trigger description
    ...
  harnesses: [claude]    # harnesses this skill supports
  ---
  ```

- Body below the frontmatter is the skill content itself (what becomes
  SKILL.md body). Harness-specific frontmatter for the installed artifact
  (e.g. Claude's `name`/`description` fields) is generated at install time
  from the kb frontmatter, not stored in the body.
- Non-skill documents (`kind:` other than `skill`) are allowed and ignored by
  `install-skill`; the kb is a general document store. `kind: placeholder` is
  the first such kind: defines a metasyntactic `<token>` once (grep-addressable
  by its `slug`) instead of letting the definition drift across consumers (see
  `kb/README.md`).

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
