---
kind: command
id: af12dc22-6bad-5e2a-aca9-ff0163dd39dd
name: prove@1
gist: "Run an executable proof for a bridge `kind: assertion` doc in an isolated child process, optionally recording the proven input commits."
scopes: []
meta:
  usage: nosedive prove <assertion-ref> [--record] [--rehydrate] [--force] [--verbose]
  agents-use-when: an assertion needs its proof run, or a change needs proving before it lands.
  adapter: kb/artifacts/019fadf5-e089-7c4d-8c97-9c6bf1db6b0f.mjs
  entrypoint: L1__prove
---

# Prove

The assertion may be named by quid, by a bridge-relative assertion doc path, or
by an absolute assertion doc path that resolves inside the bridge.

The assertion must link exactly one bridge-owned single-file prover artifact
with `rel: prover`.

The prover runs in an isolated child Node process and must export
`prove(ctx)`.

## Proof context

- `ctx.exec(command, args, { cwd })` requires an explicit command working
  directory; proof code should use context roots instead of ambient
  `process.cwd()`.
- Repositories are resolved through `ctx.repos.get(...)` or
  `ctx.repos.mustGet(...)` by repo id or kb repo `name`. `ctx.repos.require(...)`
  remains as a compatibility alias for `mustGet`. The resolved repo must be
  named by the assertion's scopes before the proof host will hydrate or expose
  it. Accessed repos are tracked as proof inputs by exact commit SHA.

## Recording

By default, proof runs are experimental and do not edit the assertion.

`--record` writes the run onto the assertion's frontmatter as:

```yaml
meta:
  last-run:
    pass: <true|false>
    commits:
      <repo-id>: <commit-sha>
```

`commits` names every repo the proof accessed, at the exact commit it was read
at. Recording also removes the superseded `meta.last-proven` and
`meta.last-proven-commit` keys if present.

Recording refuses if any accessed repo is dirty, and requires the prover
artifact itself to be checked in with no uncommitted changes. Other untracked
bridge files, including anything under the configured `workspace:`, do not
block a record, because hydration itself creates files there. Dirty scoped
repos are rejected before the prover artifact is imported or run.

Recording also refuses when a scope that pins a `ref:` has a worktree whose
HEAD is not the resolved pin, because the recorded `commits` would then name
code the proof did not run against. Drifted scopes are rejected before the
prover artifact is imported or run. Without `--record`, drift stays a warning.

## Pins

`--rehydrate` moves each drifted pinned scope's worktree to its resolved pin
instead of refusing, and reports which repos it moved and to what. It also
repairs a checkout sitting on an unrelated branch, which is otherwise fatal.
It does not require `--record`.

`--rehydrate` refuses when a scoped repo has tracked local modifications, which
would otherwise be carried onto the pin. Untracked files do not block it; they
still block a recording through the dirty-input refusal. `--force` widens only
that guard, discarding the modifications, and is an argument error without
`--rehydrate`; it never widens the drift or dirty-input record refusals.
