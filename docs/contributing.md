---
description: Work on localctl itself - local setup, tests, pull requests, dependencies and the docs site.
---

# Contributing

This page is for working on `localctl` itself. To use it, start at
[Getting started](getting-started.md).

## Local setup

```sh
git clone https://github.com/psilvmoreira/localctl.git
cd localctl/cli
npm ci
npm install -g .     # optional: puts your checkout on PATH as `localctl`
```

A source checkout reports its version as `0.0.0-development`. Real versions only exist in git
tags and on npm (see [Releasing](releasing.md#where-the-version-lives)). The update notifier is
off for this version, so working from source never prints "Update available".

In a git checkout, `localctl` reads `cluster/manifests/` straight from the repo root. `npm pack`
copies `cluster/manifests/`, `schema/`, `README.md` and `LICENSE` into `cli/` (git-ignored). Always
edit the repo-root originals, never the copies.

## Constraints to keep in mind

- **CommonJS, Node 18+.** The CLI uses `require()` and declares `"node": ">=18"`. A dependency
  that is ESM-only or needs a newer Node breaks every user on install. Changing either is a
  breaking change (`feat!:`).
- **No build step.** `cli/src` ships as written. What you run is what gets published.
- **Only `cli/package.json` `dependencies` reach users.** The root `package.json` holds release
  tooling (semantic-release) that only runs in CI.

## Tests

```sh
cd cli
npm test            # smoke test, schema parity check, unit tests (cli/test/)
npm run test:pack   # packs the real tarball, installs it in a temp prefix, runs it
```

`npm test` runs three things in a row: the smoke test (every command module loads,
`--version` matches `package.json`), `scripts/schema-check.js` (fails when
`schema/app.schema.json` and the zod schema in `src/lib/configSchema.js` list different fields, so
change both together) and the unit tests in `cli/test/config.test.js` (Node's built-in test runner).
The unit tests cover the config loader, the schema rules and the safety guards. Code that talks to
`kubectl` is tested with a fake `kubectl` script placed first in `PATH`; those tests, and the ones
that need symlinks or FIFOs, are skipped on Windows. When you add a field, add a schema rule and a
test for what it must refuse, not only for what it accepts.

CI runs `npm test` and `npm run test:pack` on Linux, macOS and Windows with Node 18 and 22, and
builds the docs with `mkdocs build --strict` (install `mkdocs` and `mkdocs-material` in a virtualenv
to run it yourself). None of these need a cluster: for
changes to setup, manifests, guards or addons, also run the flow by hand against one of the
[examples](https://github.com/psilvmoreira/localctl/tree/master/examples):

```sh
cd examples/node-app
localctl app up
localctl app status
localctl app down
```

To check generated Kubernetes YAML without deploying, run `localctl app generate-manifests` from
an app directory. `localctl app validate` checks a config without touching the cluster, and
`tilt alpha tiltfile-result` (from an app directory) shows whether Tilt accepts the generated
`Tiltfile`.

For changes that act on the cluster (namespace ownership, secrets, prune, down), test against a
throwaway cluster, never your own: create one with `k3d cluster create <name> --kubeconfig-update-default=false --kubeconfig-switch-context=false`,
write its kubeconfig to its own file (`k3d kubeconfig get <name> > file`, then change `0.0.0.0` to `127.0.0.1`
on macOS), point `KUBECONFIG` at that file and `HOME` at an empty folder, so `~/.localctl`, `~/.kube` and
the hosts file are not touched, and delete it afterwards. Do not run `localctl app up` that way: it
edits the real hosts file.

## Pull requests

1. Create a branch from an up-to-date `master`.
2. Open the PR with a [Conventional Commits](https://www.conventionalcommits.org/) **title**. PRs
   are squash-merged, so the title becomes the commit on `master` and decides the release:

    | Title | Release |
    |---|---|
    | `fix: ...`, `perf: ...` | patch |
    | `feat: ...` | minor |
    | `feat!: ...` (any type with `!`) | major |
    | `docs:`, `chore:`, `ci:`, `refactor:`, `test:`, `build:`, `style:` | none |

    GitHub fills the title from the branch name (e.g. `Ci/drop npm token`), which fails the check.
    Edit it before you merge.

3. Read the **Release preview** notice on the `pr-title` check. It shows the version that merging
   publishes, **including unreleased commits already on `master`**. A `docs:` PR can still
   release if an earlier `feat:` or `fix:` merge has not been released yet.
4. Wait for every required check: `pr-title`, `not-empty`, `docs` and the six `test` jobs.
5. Squash and merge. The branch is deleted automatically.

!!! warning "Never re-open a branch that was already merged"
    It produces a PR with no changes. The `not-empty` check fails it, because its squash commit
    would be empty: a `feat:` title would either release nothing or release identical code under
    a new version on the next merge. Start a new branch from `master` instead.

## Dependencies

Dependabot opens grouped PRs every week. What to do with them:

| PR | Action |
|---|---|
| `fix(deps):` minor or patch of a CLI dependency | Merge when CI passes. Releases a patch. |
| `fix(deps):` **major** of a CLI dependency | Check it is still CommonJS (or exports `require`) and supports Node 18 before merging. Otherwise close it with `@dependabot ignore this major version`. |
| `chore(deps-dev):` / `chore(deps):` release tooling | Merge when CI passes. Releases nothing. |
| `ci:` GitHub Actions | Merge when CI passes. Actions are pinned to a commit SHA, and Dependabot keeps the SHA and its version comment in sync. |

Some majors are already ignored in `.github/dependabot.yml`, with the reason next to each:

| Package | Ignored | Why |
|---|---|---|
| `chalk` | `>=5` | ESM-only |
| `commander` | `>=14` | Needs Node 20+ (15+ is also ESM-only) |
| `conventional-changelog-conventionalcommits` | majors | v10 broke release notes generation |

Upgrade these by hand, in a PR that also handles the breaking change.

Security alerts on release tooling (the root `package-lock.json`) don't affect users. Several come
from packages bundled inside npm itself, which `@semantic-release/npm` depends on, and can't be
fixed from this repository. Dismiss those as **Risk is tolerable to this project**. Dependabot
reopens them if a fix becomes available. Alerts in `cli/package-lock.json` always need a fix.

## Documentation site

The site is [MkDocs Material](https://squidfunk.github.io/mkdocs-material/), deployed to GitHub
Pages from the `gh-pages` branch by `.github/workflows/docs.yml` on every merge that touches
`docs/**`, `overrides/**` or `mkdocs.yml`.

Preview it locally:

```sh
pip install "mkdocs>=1.6,<2" "mkdocs-material>=9.7,<10"
mkdocs serve          # http://127.0.0.1:8000, reloads on save
mkdocs build --strict # what CI runs: any warning (e.g. a broken link) fails
```

Stay below MkDocs 2.0: it drops the plugin and theme system Material depends on.

| Path | What it holds |
|---|---|
| `docs/*.md` | The pages. |
| `mkdocs.yml` `nav:` | The tabs and sidebar. A new page must be added here. |
| `overrides/home.html` | The landing page hero. Only `docs/index.md` uses it (`template: home.html`). |
| `docs/stylesheets/extra.css` | Brand colors (from `docs/assets/favicon.svg`), the hero and small polish. |

When a change affects users (a new command, option, config field or behavior), update the docs in
the same PR: [CLI commands](cli-reference.md), [Config schema](config-schema.md) and the README.
