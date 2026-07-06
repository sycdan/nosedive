---
effort: workon
status: planned
---

# Workon

## Goal

Author the `nosedive-workon` skill: the way a developer (or agent) picks up an
effort and gets the actual work done by a subagent, with full artifact
tracking. The skill body lives in `kb/<uuid7>.md` per the
[kb-store](../installable-skills/kb-store/KbStore.md) format and is delivered
to projects via
[install-command](../installable-skills/install-command/InstallCommand.md).

## Skill behavior (what the installed skill instructs the agent to do)

Given an effort reference (slug/path):

1. **Locate the effort** under `./efforts`, resolving nesting
   (`parent/child/...`).
2. **Ensure repos are available.** Any repos the effort references must be
   present as git submodules; add/init/update them as needed.
3. **Gather context.** Read the effort doc plus related docs — parents up the
   chain, and any linked child/sibling docs that matter.
4. **Craft the work prompt.** Write a self-contained prompt for a subagent to
   do the actual work. Store it in `.artifacts/` inside the effort dir. At
   prompt-creation time, also fix the output artifact name
   (`<uuid7>-output.md`) so the run is deterministic and trackable.
5. **Create a session** under `./sessions`, named
   `<effort-slug>.<parent-slugs>.<uuid7>`, and copy the prompt file into it as
   `prompt.md`.
6. **Run the subagent.** Instruct it to read `prompt.md`, do the work, and
   write its final summary to `output.md` in the session dir.
7. **Collect output.** Wait for `output.md` to exist, then copy it into the
   effort's `.artifacts/` as `<uuid7>-output.md` with frontmatter pointing at
   the prompt that produced it.

## Open questions (resolve during design)

- Exact session-name ordering: `<effort-slug>.<parent-slugs>.<uuid7>` — confirm
  whether parents read root-first or leaf-first.
- Where the effort declares its referenced repos (frontmatter list?) so step 2
  is mechanical.
- Artifact frontmatter schema for prompt and output files (ids, timestamps,
  effort ref, prompt→output linkage).
- How "wait for output.md" behaves in harnesses without background agents
  (fallback: run inline).

## Tasks

- [ ] Resolve open questions above; document decisions in this file.
- [ ] Write the skill body in `kb/<uuid7>.md` with `kind: skill`,
      `name: nosedive-workon` frontmatter.
- [ ] Dogfood: install into this repo (`nosedive install-skill --harness claude`)
      and use `/nosedive-workon` on a real effort.

## Dependencies

- [kb-store](../installable-skills/kb-store/KbStore.md) — format the skill
  document is written in.
- [install-command](../installable-skills/install-command/InstallCommand.md) —
  needed to install/dogfood the skill.

## Acceptance

- Running `/nosedive-workon <effort>` in a project with this skill installed
  produces: a prompt artifact in the effort's `.artifacts/`, a session dir with
  `prompt.md`, and after the subagent finishes, `output.md` copied back as
  `<uuid7>-output.md` with linking frontmatter.
