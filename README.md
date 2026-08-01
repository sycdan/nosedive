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
matching command doc. Command doc UUIDs are deterministic: the package reads its
stable `.nosedive-ref` id and derives `kb/<uuid>.md` from
`command:<command>@<level>`, so command lookup does not need a full KB scan.

| Command | Doc | Status | What it does |
| --- | --- | --- | --- |
| `pitch` | [L1](kb/f9325040-bb48-57f5-a98e-bfa0f2497661.md) | Current | Create a new effort file in `backlog/`. |
| `mint` | [L1](kb/e8909eff-aee5-54f2-9ce2-85c2582e39f0.md) | Current | Generate UUIDv7 values with a specific timestamp encoded. |
| `seed` | [L1](kb/34c8e9fb-9629-5767-9a81-914f78c63b68.md) | Current | Create, migrate, or edit bridge config in the current directory. |
| `preflight` | [L1](kb/d6e4bbe3-b158-5e6d-a734-e0ce77acfdce.md) | Current | Install the bridge pre-push hook. |
| `apply` | [L0](kb/87d1019d-d2cd-509f-8f52-6fd99ea13268.md) | Deprecated | Only `--dry-run` remains, as a read-only inspection path. |
| `nuke` | [L1](kb/3570e756-f8e7-5e95-b911-09d7d116cd23.md) | Current | Remove managed bridge config. |
| `render` | [L1](kb/9b0241b2-f03f-5594-a537-60a3b4372ee9.md) | Current | Print the body of a packaged nosedive KB document. |
| `pre-push.hook` | [L1](kb/9c07d8f1-61d4-531c-a926-863ce61e4785.md) | Current | Run the bridge pre-push check registry. |
| `prove` | [L1](kb/af12dc22-6bad-5e2a-aca9-ff0163dd39dd.md) | Current | Run an executable proof for a bridge `kind: assertion` doc. |
| `list-dives` | [L1](kb/ad3bc6d7-d4cd-5381-a98f-cb13f9a801d6.md) | Current | Print pickupable and working dives for an open effort. |
| `dump-backlog` | [L1](kb/d90673eb-a8c6-537f-8c6c-3c38ddd13cc1.md) | Current | Render the configured backlog memo from bridge KB. |
| `dump-backlog` | [L0](kb/a1c8b50b-6ee2-5f91-b861-8d2546c17527.md) | Deprecated | Walk the legacy `backlog:` directory and print an effort tree. |
| `update-backlog` | [L1](kb/eb6305b4-9aa6-5fdb-b622-e0d17b6303bb.md) | Current | Regenerate the configured backlog memo from bridge KB effort docs. |
| `whoami` | [L1](kb/a40303c1-1362-523f-b095-49178354f878.md) | Current | Print the bridge pilot identity nosedive will use. |
| `add-repo` | [L1](kb/cb7c5823-486f-52af-b3bc-0f368f277b0e.md) | Current | Add a kb repo to an effort's repo list. |
| `hydrate-repo.workspace` | [L1](kb/c4e93002-2925-58bd-9b70-d917017a9fc7.md) | Current | Hydrate one repo worktree from kb `kind: repo` metadata. |
| `dehydrate-repo.workspace` | [L1](kb/32123800-a61d-5ea1-8b85-98c288b127b3.md) | Current | Remove one hydrated workspace checkout. |

`version` and `help` have no command doc; they print the package version and the
command list.

### How a command doc runs

A command doc names one repo-root handler artifact under `meta.handler`. The
handler is a single-file ES module exporting `handle(value, ctx)`. It receives
`{ args, cwd }` and must return `{ stdout, stderr, exitCode }` (`output` is
accepted as a stdout alias). Handlers call uuid-named internal implementations
through `ctx.impl` and shared named helpers through `ctx.lib`; command behavior
belongs in `src/impl` and `src/lib`, not in the user-facing handler artifact.

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

The version in [`package.json`](package.json) stays `0.0.0-dev` in git; pipeline stamps the real version at publish time. Publishing is handled by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no
token secrets. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) checks
formatting, typechecks, builds, smoke-tests the CLI ([`src/cli.ts`](src/cli.ts)),
and verifies the packed npm bin on PRs; the publish workflow runs the same
checks before publishing.
