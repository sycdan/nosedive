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

## Efforts and sessions

_nosedive_ organizes work around two core concepts, both of which live as plain files on disk:

- **Effort** — a unit of (potentially cross-repo) work to be designed and built. Each effort
  has a plan document and lives under `./efforts`. The `EffortName` matches the
  effort slug, e.g. `./efforts/dev-actions/DevActions.md`. Sub-efforts are just
  nested directories: `./efforts/dev-actions/workon/Workon.md`.
- **Session** — an actual working session on an effort. Sessions live under
  `./sessions`. Starting or resuming a session is how a developer (or agent)
  "picks up" an effort and gets back into context.

This model is **dogfooded**: _nosedive_ is itself built from a set of efforts and
sessions, and the very same structure is the product surface end users get after
installing the package.

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
token secrets. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks, builds, and smoke-tests the CLI ([`src/nosedive.ts`](src/nosedive.ts)) on PRs; the publish workflow runs the same checks before publishing.
