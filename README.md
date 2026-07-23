<p align="center">
  <img src="assets/nosedive-logo-circle.png" alt="Nosedive logo" width="180" height="180">
</p>

# Nosedive: intentional velocity

⚠️ This repo is currently undergoing active development and may undergo breaking changes without warning. ⚠️

**_nosedive_ turns a plain notes repo into a hub for cross-repo work** — a place where a
developer (and their agents) can safely pick up a piece of work that spans
several repositories, do it, and get it reviewed, without the usual friction of
juggling clones, branches, context, and half-remembered state.

## The problem

Enterprise work rarely fits inside one repository. A change to a shared library ripples
into three services; a feature needs edits in the backend, the client, and the
infra repo at once. Today that means:

- **Lost context.** Every repo is a separate world. Where was I? What was this
  branch for? What still needs review?
- **Unsafe agent use.** Handing an AI agent a shell in a shared repo is risky. Worktrees
  mitigate this, but are focused on a single repo and quickly become cumbersome.
- **Friction in the author → review loop.** Starting a unit of work, tracking it,
  and shepherding it through review is manual and inconsistent across people.

_nosedive_ addresses these by making the unit of work a first-class, on-disk object,
creating effort-scoped multi-repo workspaces, and by routing developer actions through
explicit, contract-checked commands that are equally safe for a human or an agent to run.

## Efforts and dives

_nosedive_ organizes work around two core concepts:

- **Effort** — a unit of (potentially cross-repo) work to be designed and built.
  Efforts are canonical, discrete objects under `./backlog`. The `EffortName`
  is the effort slug in PascalCase, e.g. slug `foo-bar` lives at
  `./backlog/foo-bar/FooBar.md`. Subefforts are nested directories:
  `./backlog/foo-bar/baz-qux/BazQux.md`.
- **Domain directory** — a namespace under `./backlog` with no matching
  PascalCase effort file of its own. Domain dirs group project work without
  being closable efforts, but they do participate in slug chains, e.g.
  `./backlog/gogglebox/auth-refactor/AuthRefactor.md` is
  `auth-refactor.gogglebox`.
- **Dive** — one concrete iteration on an effort. Dives are `kind: dive` docs
  that record who is actively working, handoff notes, branch state, and linked
  artifacts.

## Commands

### pitch

Create a new effort file in `backlog/`.

Usage:

`nosedive pitch <slug> [--gist "<gist>"] [--pitch "<pitch>"] [--parent <parent>]`

- `<slug>` is the effort directory name in kebab-case.
- `--parent` can be an effort path, a domain directory path such as
  `backlog/gogglebox`, or a leaf-first slug chain such as `baz-qux.foo-bar`.
- Pitch writes the new effort file locally.

### mint

Generate UUIDv7 values with a specific timestamp encoded.

Usage:

`nosedive mint <timestamp> [count]`

- `<timestamp>` accepts an ISO date string or Unix milliseconds.
- `count` defaults to `1`.

Example:

`npx -y nosedive@dev mint 1997-08-29T02:14:00-04:00`

### init

Create or edit `.nosediverc` in the current directory.

Usage:

`nosedive init`

- Prompts for workspace, backlog, kb, home branch, work branch prefix, and
  pilot identity, and `agents`.
- Existing values (or defaults) are shown and kept by pressing Enter.
- `agents` defaults to `copilot` (with `claude` as an optional additional
  target).

### list-dives

Print pickupable and working dives for an open effort.

Usage:

`nosedive list-dives <effort> [--include-historical] [--json]`

- `<effort>` accepts an effort path, effort directory path, or leaf-first slug
  chain.
- The default output shows pickupable `pending-dives` from the effort
  frontmatter plus working dives whose `meta.diver` is set.
- `--include-historical` also scans preserved dive records for the effort so
  the full progression can be inspected.
- `--json` prints the same sections as structured data for agent workflows.

### whoami

Print the bridge pilot identity that nosedive will use from the current
directory.

Usage:

`nosedive whoami`

- Searches upward for the nearest `.nosediverc`.
- Prints `pilot-name` and `pilot-email` from explicit bridge config.
- Falls back per missing field to `git config user.name` or
  `git config user.email` with a notice on stderr.
- Prints `<unset>` and exits nonzero when a missing field cannot be inferred
  from git config.
- Does not modify `.nosediverc`, git excludes, backlog files, kb files, or
  workspace markers.

### hydrate-repo.workspace

Hydrate one repo worktree from kb `kind: repo` metadata and keep it detached at
the resolved commit.

Usage:

`nosedive hydrate-repo.workspace <repo-id-or-name> [--at <ref>] [--read-only]`

- `<repo-id-or-name>` is required and must match either a kb `kind: repo` `id`
  or an exact `name`; duplicate names fail as ambiguous.
- `--at <ref>` chooses the source ref and defaults to `main`.
- `--read-only` sets the hydrated worktree's worktree-local
  `remote.origin.pushurl=no_push://disabled`.

Behavior:

- Path resolution uses canonical `meta.path`, with deprecated
  `meta.worktree-path` accepted only as a compatibility fallback.
- A managed git cache is prepared at `.nosedive/cache/<repo-id>` for the
  resolved repo id, and workspace worktrees are created from that cache.
- `meta.remotes.cloud` is preferred as the cache upstream; `meta.remotes.local`
  is only a seed source when no cloud remote is configured.
- Target path must remain inside configured `workspace:` after canonical path
  resolution.
- Hydration writes `.nosedive-ref` at repo root with `id: <repo-id>` for strict
  ownership checks on reuse.
- Success status is always one of `created`, `updated`, or `noop`.

### dehydrate-repo.workspace

Remove one hydrated workspace checkout for a kb repo without touching managed
cache or bridge metadata.

Usage:

`nosedive dehydrate-repo.workspace <repo-id-or-name-or-workspace-path> [--force]`

- `<repo-id-or-name-or-workspace-path>` is required and accepts either:
  - a repo `id`
  - an exact repo `name`
  - a bridge-workspace-relative directory path (or `.nosedive-ref` path)
    for an already hydrated checkout
- `--force` bypasses local dirty/unpublished-work protection only.

Behavior:

- The command resolves and validates the configured workspace target for the
  repo and requires the managed `.nosedive-ref` ownership marker before
  removing anything.
- Target paths must remain inside configured `workspace:` and cannot be
  widened by `--force`.
- Without `--force`, dehydration refuses to remove a checkout with uncommitted
  changes or unpublished commits.
- Success status is always one of `removed` or `noop`.

## Development

Run `npm install` once after cloning. Its `prepare` script points git at
[`.githooks`](.githooks), installing a `pre-push` hook that checks formatting,
typechecks, builds, and tests before every push — the same gate CI enforces.
Use `npm run format` to apply the repo-local Prettier config. Bypass a one-off
push with `git push --no-verify`.

### Versioning + publishing

Versions are CalVer, computed by [`scripts/version.mjs`](scripts/version.mjs):

- **Dev builds** — `yyyy.m.d-<utc-millis>`, published to the `dev` dist-tag on every
  push to `main` (`npm install nosedive@dev`).
- **Releases** — `yyyy.m.d`, published to `latest` by manually running the
  **Publish** workflow ([Actions → Publish](https://github.com/sycdan/nosedive/actions/workflows/publish.yml) → Run workflow), which also creates the
  git tag and GitHub release. Max one release per day; npm rejects duplicate versions, which enforces this

The version in [`package.json`](package.json) stays `0.0.0-dev` in git;  pipeline stamps the real version at publish time. Publishing is handled by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no
token secrets. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) checks
formatting, typechecks, builds, smoke-tests the CLI ([`src/cli.ts`](src/cli.ts)),
and verifies the packed npm bin on PRs; the publish workflow runs the same
checks before publishing.
