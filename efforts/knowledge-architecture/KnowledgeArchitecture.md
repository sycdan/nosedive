---
effort: knowledge-architecture
status: planned
---

# Knowledge Architecture

## Goal

Define how knowledge lives, loads, and stays fresh in this repo so that:

- an agent (or human) can **reliably learn what it needs** with minimal context
  cost and minimal tool calls;
- knowledge has **exactly one canonical home**, so it can't drift;
- every session can **leave the KB better than it found it** (boy-scout rule)
  by writing new knowledge back to that one home.

This is the connective tissue under [kb-store](../kb-store/KbStore.md),
[installable-skills](../installable-skills/InstallableSkills.md), and
[workon](../workon/Workon.md): those efforts produce and consume knowledge; this
effort says where it lives and how it reaches an agent.

## The core tension

Two properties fight each other:

- **Reliably loaded** — favours embedding content in the agent-instructions file
  (`CLAUDE.md`), which the harness auto-injects every session with zero tool
  calls. This is why the backlog currently lives inline in `CLAUDE.md`.
- **Single source of truth** — favours pointing at `efforts/` and `kb/`, the
  canonical, self-describing stores.

Embedding buys reliability but duplicates the source → drift (already observed:
commit `3c7f14f "docs: fix cross-doc inconsistencies"`, and the manual scan that
produced this effort). The resolution is **not** to pick a side. It is:

> **The always-loaded copy must be _derived_, never _authored_.**

## The model: three layers by load-cost

- **L0 — Always loaded** (`CLAUDE.md` / `.github/copilot-instructions.md`).
  Free per session (no tool call) but paid on every session, and
  reliability-critical. **It is a router, not a library.** It holds only: (a)
  the map — how to find everything else; (b) invariants — conventions and the
  write-back rule; (c) a _generated_ "what's in flight" digest. Not hand-written
  content.
- **L1 — On-demand, addressable** (`kb/`, `efforts/`). Canonical truth. Loaded
  by tool call when relevant. Every document is self-describing via frontmatter
  and discoverable from L0.
- **L2 — Derived surfaces** (the L0 digest, the kb index, `install-skill`
  outputs, the composed agent-instructions files). Regenerated from L1, **never
  edited by hand**, and marked as generated so agents don't touch them.

The current backlog-in-`CLAUDE.md` is an L2 surface authored by hand inside an L0
file. That is the whole bug.

## Principles

### 1. Generated harness targets from `kb/`

The agent-instructions file is not special — it is a **generated harness target**,
sourced from `kb/`, exactly like `install-skill` generates
`.claude/skills/<slug>/SKILL.md`. Extend the same materialization: documents of a
new kind (`kind: agent-instructions`) plus the backlog digest compose into
`CLAUDE.md` / `.github/copilot-instructions.md`, per harness.

**One materialization pipeline, N harness targets, source = `kb/` + `efforts/`.**
`install-skill` is one case of this pipeline.

### 2. Derive, don't author (and don't use clean/smudge to do it)

L2 surfaces are regenerated, not hand-maintained. The trigger for regeneration is
an explicit `nosedive` command and/or a git hook — **not** a git clean/smudge
filter. See the decision record below for why smudge was rejected.

### 3. One home per fact-type (the write-back rule)

Agents leave the KB better only if there is exactly one home per kind of fact,
stated in L0 so every session knows it:

| Learned…                    | Home                                          |
| --------------------------- | --------------------------------------------- |
| transient / this-task-only  | nowhere                                       |
| meaning of a `<token>`      | `kb/` `kind: placeholder`                     |
| effort state / plan         | that effort's `.md` (frontmatter + body)      |
| a convention / invariant    | `CLAUDE.md`, or a `kb/` doc it points to      |
| an external pointer         | `kb/` reference doc                           |

### 4. Navigation primitive: grep-by-slug

Agents navigate by grep, not by memorising paths. Every `slug` is unique, so
`rg '^slug: <token>$' kb` resolves any term to its one canonical definition
(already established in [kb/README.md](../../kb/README.md)). L0 states this
primitive in one line so every session inherits it.

## Decisions

### D1 — Reject git clean/smudge for templating the instructions file

**Considered:** store `CLAUDE.md` in git as a template with placeholders; a
smudge filter populates it on checkout (grep `kb/`, compose backlog); a clean
filter strips it back before commit.

**Rejected.** The instinct (fresh on checkout, zero tool call, zero staleness) is
right, but the mechanism is too sharp, and it cuts exactly where we care:

1. **clean must perfectly invert smudge.** `CLAUDE.md` is also where agents add
   conventions by hand. An edit inside a generated region is either destroyed by
   clean or pollutes the template. Round-trip inversion is a data-loss footgun.
2. **Filters are local `.git/config`, not shipped by a clone.** `.gitattributes`
   is committed but the filter program is not. A fresh clone before setup shows
   the raw template with literal placeholder markers — a broken-looking file.
3. **Merge/diff inside generated regions** produces spurious churn and ugly
   conflicts.

**Chosen instead**, in preference order:

- **Committed generated block** between markers + a `nosedive check` freshness
  gate (CI fails if stale). Portable across harnesses, visible in plain diffs, no
  round-trip. Trade-off: can be momentarily stale between regenerate and commit —
  the gate catches it.
- **Generated gitignored file + `@import`.** `CLAUDE.md` imports
  `@.claude/backlog.generated.md`; that file is gitignored and regenerated by a
  `post-checkout`/SessionStart hook. Claude auto-loads `@imports`; a missing file
  degrades gracefully. Trade-off: `@import` is Claude-only; copilot needs the
  content inlined.

### D2 — Split `description` into `gist` + skill trigger

Today one frontmatter field is overloaded: it is both the doc's one-liner and, for
`kind: skill`, the harness invocation trigger. Split them:

- **`gist`** (all docs) — a one-line _summary of what the doc says_, not merely
  what it covers. A listing of `slug — gist` lets an agent (or a human running
  `ls`) skip the body entirely when the gist answers the question. This is the
  primary context-efficiency lever.
- **skill invocation description** (`kind: skill` only) — describes _when to
  fire_ the skill and matches user phrasing; a body-summary is a poor trigger, so
  it stays a separate field.

**Trade-off accepted:** a `gist` summarises content, so it must be re-touched when
the body's substance changes (whereas "what it covers" rarely does). Mitigation:
the write-back rule gains _"edit a kb body → update its gist,"_ and `nosedive
check` enforces presence + a length bound (accuracy can't be auto-verified).

### D3 — Generated kb index

`nosedive` generates an index of `slug — gist` for every `kb/` doc (a `kb/INDEX.md`
and/or a block injected into L0). This is the skim surface that lets agents answer
from gists without reading bodies — the concrete payoff of D2.

## The spine: `nosedive` generate + check

Everything above collapses into one tool responsibility:

- **generate** the L2 surfaces from L1: composed agent-instructions files, the kb
  gist-index, the backlog digest. (`install-skill` is one generator among these.)
- **check** the invariants, wired into the existing pre-push hook + CI (which
  already run typecheck/build/test): broken relative links across `*.md`,
  generated-block freshness, effort `status:` frontmatter vs the backlog digest,
  and `gist` presence.

This converts "manually scan for drift" into an enforced gate — prevention, not
cleanup.

## Open questions

- Command surface: one `nosedive docs` (generate + check subcommands) vs.
  separate `nosedive generate` / `nosedive check`? How does `install-skill` sit
  under it?
- Portable digest delivery: committed generated block (D1 option 1) vs. gitignored
  `@import` (D1 option 2) — pick one as the default, or support both per harness?
- Exact `kind: agent-instructions` schema and how per-harness composition selects
  and orders documents.
- Whether the kb index is a committed file, an L0-injected block, or both.

## Tasks

- [ ] Ratify this model; resolve the open questions and record decisions here.
- [ ] D2: rename `description` → `gist` in `kb/` frontmatter; add the separate
      skill-invocation field; update [kb/README.md](../../kb/README.md) and the
      two existing kb docs' frontmatter to real gists. (Cheap, high value — do
      first.)
- [ ] Extend the write-back rule into L0 (`CLAUDE.md`) and add
      _"edit a kb body → update its gist."_
- [ ] Build `nosedive check` (broken links, status sync, gist presence,
      freshness) and wire it into [.githooks/pre-push](../../.githooks/pre-push)
      and `ci.yml`.
- [ ] Build `nosedive generate` for the backlog digest; replace the hand-authored
      `CLAUDE.md` "Current efforts" block with a generated one.
- [ ] Generalise the generator to compose agent-instructions files from
      `kind: agent-instructions` kb docs (folds `install-skill` into the same
      pipeline).

## Dependencies

- [kb-store](../kb-store/KbStore.md) — the store + frontmatter these generators
  read; D2 changes its schema.
- [install-skill](../installable-skills/install-skill/InstallSkill.md) — the
  first generator; this effort generalises its pipeline.

## Acceptance

- The `CLAUDE.md` "Current efforts" digest is generated from `efforts/`
  frontmatter, not hand-authored, and `nosedive check` fails when it is stale or a
  relative doc link is broken.
- Every `kb/` doc carries a `gist`; a generated index lists `slug — gist`.
- L0 states the write-back rule and the grep-by-slug primitive, so a fresh agent
  session knows where knowledge lives and how to find it without prior context.
- No git clean/smudge filter is used to achieve any of the above (see D1).
