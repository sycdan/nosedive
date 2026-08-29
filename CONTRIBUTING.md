# Contributing to Nosedive

## Setup

- `npm install` after cloning to install dependencies and set up git hooks.

## Development

- `npm run format` to apply the repo-local Prettier config.

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
