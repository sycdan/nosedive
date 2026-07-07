---
effort: workon
status: planned
---

# Workon

## Goal

Author the `nosedive-workon` skill: the way a developer (or agent) picks up an
effort and gets the actual work done by a subagent, with full artifact
tracking. The skill body lives in `kb/<uuid>.md` per the
[kb-store](../kb-store/KbStore.md) format and is delivered
to projects via
[install-skill](../installable-skills/install-skill/InstallSkill.md).

## Skill behavior (what the installed skill instructs the agent to do)

Given an effort reference (slug/path):

1. **Locate the effort** under `./efforts`, resolving nesting
   (`parent/child/...`).
2. **Ensure repos are available.** The effort doc's `repos` frontmatter (see
   below) lists the submodules the effort touches; add/init/update them as
   needed, and honor each repo's `writable` flag.
3. **Gather context.** Read the effort doc plus related docs — parents up the
   chain, and any linked child/sibling docs that matter.
4. **Create a session** under `./sessions` (gitignored), named
   `<slug-chain>.<uuid>` (the effort's
   [slug chain](../../kb/019f39dc-8ebf-7735-812d-522cc242a8b8.md) plus a
   session uuid).
5. **Craft the work prompt.** Write a self-contained prompt for a subagent to
   do the actual work, directly into the session dir as `prompt.md`. At
   prompt-creation time, also fix the artifact names
   (`<uuid>-prompt.md` / `<uuid>-output.md`, reusing the session's uuid) so
   an accepted run is deterministic and trackable. Nothing is copied to the effort's
   `.artifacts/` yet — sessions may be throwaway.
6. **Materialize the session workspace.** For each repo in the effort's
   `repos`, the main agent (not the subagent) creates a git worktree from the
   submodule inside the session dir, named by repo name without org
   (`<session-dir>/backend/` — org suffix only exists to keep submodule paths
   unique; collisions inside one session are unlikely):
   - **Writable repos** — worktree on a new branch named
     `nosedive/session/<session-dir-name>`, e.g.
     `git worktree add -b nosedive/session/<session-dir-name> <session-dir>/<repo> <base>`.
     One consistent branch name across all writable repos in the session makes
     the session's edits easy to find, diff, and push later. `<base>` is the
     repo's effort branch `nosedive/effort/<slug-chain>` if it exists
     (rework / PR feedback continues from accepted work), otherwise the repo's
     default branch.
   - **Read-only repos** — worktree detached at the current commit (no branch
     needed); present for context only.
7. **Run the subagent.** Instruct it to read `prompt.md`, do the work, and
   write its final summary to `output.md` in the session dir. The prompt
   states explicitly which worktrees in the workspace are writable and that
   the rest must not be modified.
8. **Collect output.** Wait for `output.md` to exist in the session dir, then
   present it to the user for audit. What happens next is a user decision (see
   Session lifecycle below).

## Session lifecycle

`./sessions` is gitignored: a session is machine-local working state, and its
worktrees couldn't be tracked in the hub repo anyway. The durable record is
created only when the user accepts a session.

After auditing `output.md`, the user either:

- **Accepts.** For each writable repo, the session branch
  (`nosedive/session/<session-dir-name>`) is merged into that repo's effort
  branch `nosedive/effort/<slug-chain>` (created on first accept) — the
  PR-able branch that accumulates accepted work across sessions; later
  sessions base off it for rework and PR feedback. The session's `prompt.md` and
  `output.md` are copied into the effort's `.artifacts/` as
  `<uuid>-prompt.md` and `<uuid>-output.md` (output frontmatter points at
  its prompt), committing the record to the hub repo.
- **Abandons.** Session branches are discarded; nothing reaches the effort
  branch or `.artifacts/`.

In both cases cleanup then removes the session's worktrees, deletes the
`nosedive/session/*` branches, and deletes the session dir.

## Effort frontmatter: repos

An effort doc declares the repos it touches in its frontmatter, making the
"ensure repos" step mechanical and scoping what the subagent may modify:

```yaml
---
effort: example-effort
status: planned
repos:
  - path: repos/backend.acme       # submodule path: repos/<repo>.<org>
    url: git@github.com:acme/backend.git  # used to add submodule if missing
    writable: true                 # subagent may commit here
  - path: repos/shared-lib.acme
    url: git@github.com:acme/shared-lib.git
    writable: false                # context only; must not be modified
---
```

- `path` — submodule location relative to the hub-repo root; also the identity
  used to check whether the submodule already exists. Convention is
  `repos/<repo>.<org>` so same-named repos from different orgs don't collide.
- `url` — clone source, used only when the submodule is missing.
- `writable` — `true`: workon prepares the repo for changes (e.g. work
  branch) and the subagent prompt permits edits there. `false` (default):
  read-only reference material; the prompt instructs the subagent not to
  modify it.
- Child efforts inherit parent `repos` entries; a child may re-list a repo to
  override `writable`.

## Open questions (resolve during design)

- Artifact frontmatter schema for prompt and output files (ids, timestamps,
  effort ref, prompt→output linkage).
- How "wait for output.md" behaves in harnesses without background agents
  (fallback: run inline).
- Whether accept/abandon/cleanup is driven by the skill (agent runs git
  commands) or by dedicated `nosedive` commands the skill calls.

## Tasks

- [ ] Resolve open questions above; document decisions in this file.
- [ ] Write the skill body in `kb/<uuid>.md` with `kind: skill`,
      `slug: nosedive-workon` frontmatter. Include: skill ensures `sessions/`
      is in the hub repo's `.gitignore` before creating a session.
- [ ] Dogfood: install into this repo (`nosedive install-skill --harness claude`)
      and use `/nosedive-workon` on a real effort.

## Dependencies

- [kb-store](../kb-store/KbStore.md) — format the skill
  document is written in.
- [install-skill](../installable-skills/install-skill/InstallSkill.md) —
  needed to install/dogfood the skill.

## Acceptance

- Running `/nosedive-workon <effort>` in a project with this skill installed
  produces a session dir with `prompt.md` and one worktree per effort repo
  (writable ones on branch `nosedive/session/<session-dir-name>`, read-only
  ones detached), and after the subagent finishes, `output.md` in the session
  dir awaiting audit.
- Accepting a session merges its branches into
  `nosedive/effort/<slug-chain>` per writable repo and lands
  `<uuid>-prompt.md` + `<uuid>-output.md` (with linking frontmatter) in the
  effort's `.artifacts/`; abandoning leaves no trace. Both paths clean up
  worktrees, session branches, and the session dir.
