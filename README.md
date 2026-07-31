<p align="center">
  <img src="assets/nosedive-logo-circle.png" alt="Nosedive logo" width="180" height="180">
</p>

# Nosedive: intentional velocity

Imagine:
```bash
$ npx nosedive jump "my backend" --target testing
Hi <Pilot>, N[o]O[rdinaryS[oftware]E[engineer] here!
<is first run: yes> I see you're new here -- welcome! Let's pack your 'chute first.
                    <opencode run "follow the onboarding runbook">
Lemme look some stuff up, then I'll help you get your ass into the sandbox.
Reading kb...
Ok, let's dive in!
Framing questions...
Building expectations...
Writing assertions...
Passing gates...
Outcome:
- all gates passed
- all CRITs hit
- my-backend PR, awaiting approval
```

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
explicit, command-doc-checked commands that are equally safe for a human or an agent to run.

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

Every user-facing command is defined by a `kind: command` document in this
package's [`kb/`](kb). The command document is the single source of truth for
what the command does and for its help text: `nosedive <command> --help` prints
that document's body in a markdown fence, followed by `Usage: <meta.usage>` and
the document gist. To avoid documentation drift, this README links to the
command docs rather than restating them.

Command docs are named `<command>@<level>`. nosedive resolves the highest level
that is compatible with the bridge's `compatibility-level`, so a bridge pins the
behavior it gets. `nosedive <command>@<level>` selects one explicitly. Legacy
`.nosediverc` bridges report compatibility level 0, so they use `@0` command docs
where present and stay on built-in implementations for commands without a
matching command doc.

| Command | Command doc | What it does |
| --- | --- | --- |
| `pitch` | [pitch@0](kb/019fadf5-e092-74de-9f9d-8a56c868664e.md) | Create a new effort file in `backlog/`. |
| `mint` | [mint@0](kb/019fadf5-e080-796c-9eca-bb521daf84bf.md) | Generate UUIDv7 values with a specific timestamp encoded. |
| `seed` | [seed@1](kb/019fadf5-e082-7558-945f-d136295b1ea5.md) | Create, migrate, or edit bridge config in the current directory. |
| `preflight` | [preflight@0](kb/019fadf5-e086-7c7b-812d-964284b06e58.md) | Install the bridge pre-push hook. |
| `apply` | [apply@0](kb/019fadf5-e09a-777c-abdd-28e6fd2f7ab8.md) | Deprecated; only `--dry-run` remains, as a read-only inspection path. |
| `nuke` | [nuke@1](kb/019fadf5-e09c-7989-80ae-a87afb01ea63.md) | Remove managed bridge config. |
| `render` | [render@0](kb/019fadf5-e08a-7682-91f9-bb208cc306c9.md) | Print the body of a packaged nosedive KB document. |
| `pre-push.hook` | [pre-push.hook@0](kb/019fadf5-e08c-7a33-a077-c545d9f764d5.md) | Run the bridge pre-push check registry. |
| `prove` | [prove@0](kb/019fadf5-e088-7ee1-b8d6-4cb36ef24363.md) | Run an executable proof for a bridge `kind: assertion` doc. |
| `list-dives` | [list-dives@0](kb/019fadf5-e090-7dd8-b931-4db0eb104326.md) | Print pickupable and working dives for an open effort. |
| `dump-backlog` | [dump-backlog@0](kb/019fadf5-e08e-7f5e-b7d0-3b654b828512.md) | Print the open efforts in the configured backlog. |
| `whoami` | [whoami@1](kb/019fac05-29ba-7056-bb18-4bd6d44ed7df.md) | Print the bridge pilot identity nosedive will use. |
| `add-repo` | [add-repo@0](kb/019fadf5-e094-7176-afd0-94532d2bb149.md) | Add a kb repo to an effort's repo list. |
| `hydrate-repo.workspace` | [hydrate-repo.workspace@0](kb/019fadf5-e096-7e87-a2f2-56edf58c7de9.md) | Hydrate one repo worktree from kb `kind: repo` metadata. |
| `dehydrate-repo.workspace` | [dehydrate-repo.workspace@0](kb/019fadf5-e098-76f7-a4eb-d106bb6714a1.md) | Remove one hydrated workspace checkout. |

`version` and `help` have no command doc; they print the package version and the
command list.

### How a command doc runs

A command doc links one or more artifacts with `rel: executor`. Each executor is a
single-file ES module exporting `run(value, ctx)`, and they are applied in link
order, each receiving the previous one's return value. The first receives
`{ args, cwd }`, and the last must return `{ stdout, stderr, exitCode }`
(`output` is accepted as a stdout alias). `ctx.invoke(command, args)` runs the
built-in implementation with a capturing io and returns what it wrote, which is
how most executors reuse the typechecked implementation rather than restating
it.

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
