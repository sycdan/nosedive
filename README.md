<p align="center">
  <img src="assets/nosedive-logo-circle.png" alt="Nosedive logo" width="180" height="180">
</p>

# Nosedive: intentional velocity

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

Run `nosedive pitch <slug> [--gist "<gist>"] [--pitch "<pitch>"]` to create a
top-level effort, or add `--parent <parent>` to create it under an existing
effort or domain directory. `<parent>` can be a backlog path, a domain directory
path such as `backlog/gogglebox`, or a leaf-first effort slug chain such as
`baz-qux.foo-bar`. Pitch writes the new effort file locally.

`nosedive mint <timestamp> [count]` generates UUIDv7 values with a specific
timestamp encoded (ISO date string or Unix milliseconds). This is available via
the published bin too, for example:

`npx -y nosedive@dev mint 1997-08-29T02:14:00-04:00`

`nosedive init` creates or edits `.nosediverc` in the current directory,
prompting for each setting (workspace, backlog, kb, sessions, home branch,
work branch prefix, and `agents`  which agent(s) to generate instructions
for, `copilot` by default with `claude` as an additional/alternative
choice). Existing values, or the built-in defaults, are shown as the default
for each prompt; press Enter to keep it.

## Development

Run `npm install` once after cloning. Its `prepare` script points git at
[`.githooks`](.githooks), installing a `pre-push` hook that typechecks, builds,
and tests before every push — the same gate CI enforces. Bypass a one-off push
with `git push --no-verify`.

### Versioning + publishing

Versions are CalVer, computed by [`scripts/version.mjs`](scripts/version.mjs):

- **Dev builds** — `yyyy.m.d-<utc-millis>`, published to the `dev` dist-tag on every
  push to `main` (`npm install nosedive@dev`).
- **Releases** — `yyyy.m.d`, published to `latest` by manually running the
  **Publish** workflow ([Actions → Publish](https://github.com/sycdan/nosedive/actions/workflows/publish.yml) → Run workflow), which also creates the
  git tag and GitHub release. Max one release per day; npm rejects duplicate versions, which enforces this

The version in [`package.json`](package.json) stays `0.0.0-dev` in git;  pipeline stamps the real version at publish time. Publishing is handled by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no
token secrets. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks, builds, smoke-tests the CLI ([`src/cli.ts`](src/cli.ts)), and verifies the packed npm bin on PRs; the publish workflow runs the same checks before publishing.
