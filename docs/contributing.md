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
npm test            # every command module loads, --version matches package.json
npm run test:pack   # packs the real tarball, installs it in a temp prefix, runs it
```

CI runs both on Linux, macOS and Windows with Node 18 and 22. Neither test needs a cluster: for
changes to setup, manifests or addons, also run the flow by hand against one of the
[examples](https://github.com/psilvmoreira/localctl/tree/master/examples):

```sh
cd examples/node-app
localctl app up
localctl app status
localctl app down
```

To check generated Kubernetes YAML without deploying, run `localctl app generate-manifests` from
an app directory.

### End-to-end suite

One command exercises the whole CLI against a real cluster:

```sh
cd cli
npm run test:e2e
```

It is built to be safe to run on your working machine:

1. **Isolated.** State, hosts file and kubeconfig live in a throwaway directory
   (`LOCALCTL_HOME`, `LOCALCTL_HOSTS_FILE`, `KUBECONFIG`), so your `~/.localctl`, `/etc/hosts` and
   `~/.kube` are never read or written. The test cluster is called `localctl-e2e`.
2. **Your clusters are stopped, never deleted.** A second k3s cluster does not fit next to yours
   on a small VM, so the suite records what is running (clusters, registries, background dev
   loops and the apps in them), stops it with `k3d cluster stop` / `<engine> stop` (volumes and
   deployments untouched) and shows you the list first. Use `--yes` to skip the question.
3. **Cleans up after itself.** Only resources named `localctl-e2e*` are removed.
4. **Asks before giving your machine back.** At the end it offers to start your clusters,
   registries and apps again. Answer later with `npm run test:e2e -- --restore`.

The result is printed as a report (passed / failed / skipped, with the error and the tail of the
log for every failure) and written to `cli/.e2e-reports/<timestamp>/` as `report.md`,
`report.json` and one log file per test (plus cluster diagnostics when something fails).

| Option | Effect |
|---|---|
| `--yes` | don't ask before stopping your clusters |
| `--offline-only` | only tests that need no cluster; stops nothing |
| `--skip a,b` | skip groups (`cluster`, `app-lifecycle`, `projects`, `addons`, `heavy`, ...) |
| `--only id,id` | run specific tests (see `--list`) |
| `--with-heavy` | also run the Prometheus/Loki addon tests (several GB of memory) |
| `--keep-cluster` | leave `localctl-e2e` up afterwards |
| `--keep-artifacts` | keep the throwaway state directory (hosts file, kubeconfig, app copies) |
| `--restore` / `--restore-after` | restore now / restore without asking at the end |
| `--list` | list the tests |

On GitHub the same suite runs on clean Ubuntu runners (`.github/workflows/e2e-linux.yml`, for PRs
into `beta` or by hand). There nothing needs protecting, so that job also runs `localctl setup`,
which the local run skips on purpose because it would touch your real `local-dev` cluster.

#### Across Linux distributions

```sh
cd cli
npm run test:e2e:distros                  # all distributions, one after another
npm run test:e2e:distros -- --distros arch,debian-12
npm run test:e2e:distros -- --list
```

Each distribution runs in a privileged container on your Docker or Podman. Inside it the runner
installs the prerequisites and Node.js, starts its own `dockerd`, then runs `localctl setup`,
`localctl doctor` and this suite, so your own clusters are never touched. Distributions:
`ubuntu-24.04`, `ubuntu-22.04`, `debian-12`, `fedora-41`, `rocky-9`, `opensuse-leap-15.6` and
`arch` (the unofficial `agners/archlinuxarm` image on arm64).

- Give the Podman or Docker VM at least **4 GB** of memory; a distribution takes several
  minutes (Arch took 6 on an Apple-silicon Mac). Containers run as the same CPU architecture as your machine.
- The output is a matrix (prerequisites, Node, dockerd, setup, doctor, tests) per distribution,
  with logs under `cli/.e2e-reports/distros-<timestamp>/<distro>/`.
- Docker image layers are cached in volumes named `localctl-e2e-docker-<distro>` so re-runs are
  fast. `--prune-volumes` deletes them at the end.
- `--addons` also runs the addon tests, `--timeout <min>` changes the per-distribution limit
  (default 40). On macOS the run is kept awake with `caffeinate`.

Tests live in `cli/scripts/e2e/tests/`. Add one with `runner.add({ id, group, title, needs,
run })`; `needs` skips the test (with the reason) when a test it relies on did not pass. It
deliberately does not cover `localctl setup` (that is your own `local-dev` cluster) or
`localctl uninstall` (destructive, machine-wide).

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
