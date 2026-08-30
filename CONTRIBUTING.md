# Contributing to Nosedive

## Setup

- `npm install` after cloning to install dependencies and set up git hooks.

## Development

- `npm run format` to apply the repo-local Prettier config.

## Sign your work

Nosedive uses the [Developer Certificate of Origin](DCO) -- a one-line statement that
you wrote the contribution, or otherwise have the right to submit it under the MIT
license. There is no agreement to sign and no rights are transferred; you keep the
copyright on what you write.

Certify a commit by adding a `Signed-off-by` trailer with your real name:

```sh
git commit -s -m "..."
```

To sign off a branch you already committed:

```sh
git rebase --signoff main
```

The pre-push hook checks the commits you are about to push, and CI checks every
non-merge commit in a pull request. Both run `npm run check:signoff`, which with no
argument checks whatever no remote holds yet.

## Versioning + publishing

Versions are CalVer, computed by [`scripts/version.mjs`](scripts/version.mjs):

- **Dev builds** -- `yyyy.m.d-<utc-millis>`, published to the `dev` dist-tag on every
  push to `main` (`npm i -g nosedive@dev`).
- **Releases** -- `yyyy.m.d`, published to `latest` by manually running the **Publish**
  workflow ([Actions -> Publish](https://github.com/sycdan/nosedive/actions/workflows/publish.yml)
  -> Run workflow), which also creates the git tag and GitHub release. Max one release
  per day, as npm rejects duplicate versions.

Publishing is handled by [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) -- no
token secrets. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) checks PRs.
