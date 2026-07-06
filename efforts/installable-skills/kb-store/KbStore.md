---
effort: kb-store
parent: installable-skills
status: planned
---

# KB Store

## Goal

Define the `kb/` directory at the repo root as nosedive's knowledge base: a
flat store of markdown documents named `<uuid7>.md`, each self-describing via
frontmatter. Documents whose frontmatter marks them as user-installable skills
are what `nosedive install-skill` picks up.

## Design

- Files are named by UUIDv7 (time-ordered, so directory listing roughly follows
  creation order). The uuid is the document's stable identity; human-readable
  identity lives in frontmatter.
- Frontmatter schema (initial, for skill documents):

  ```yaml
  ---
  id: <uuid7>            # matches filename
  kind: skill            # marks document as user-installable skill
  name: nosedive-workon  # install name; becomes the skill directory name
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
  `install-skill`; the kb is a general document store.

## Tasks

- [ ] Create `kb/` directory with a short `kb/README.md` describing the format.
- [ ] Decide + document the frontmatter schema (above is the starting point).
- [ ] Add a uuid7 generation helper (small in-repo implementation or `uuid`
      package) for use by tooling/tests; authoring can also be manual.

## Acceptance

- Format documented in `kb/README.md`.
- At least one valid skill document exists (delivered by the
  [workon](../../workon/Workon.md) effort).
