<div align="center">

<img src="https://raw.githubusercontent.com/psilvmoreira/localctl/master/docs/assets/favicon.svg" alt="localctl logo" width="96" height="96">

# localctl

**Local Kubernetes for app developers. One CLI, one cluster, a real HTTPS subdomain per app.**

[![npm version](https://img.shields.io/npm/v/@localctl/cli?logo=npm&color=cb3837)](https://www.npmjs.com/package/@localctl/cli)
[![npm downloads](https://img.shields.io/npm/dm/@localctl/cli?color=cb3837)](https://www.npmjs.com/package/@localctl/cli)
[![Node.js](https://img.shields.io/node/v/@localctl/cli?logo=node.js&logoColor=white&color=5fa04e)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/psilvmoreira/localctl?color=blue)](https://github.com/psilvmoreira/localctl/blob/master/LICENSE)
<br>
[![Release](https://github.com/psilvmoreira/localctl/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/psilvmoreira/localctl/actions/workflows/release.yml)
[![Tests](https://github.com/psilvmoreira/localctl/actions/workflows/ci.yml/badge.svg)](https://github.com/psilvmoreira/localctl/actions/workflows/ci.yml)
[![Docs](https://github.com/psilvmoreira/localctl/actions/workflows/docs.yml/badge.svg?branch=master)](https://psilvmoreira.github.io/localctl/)
[![semantic-release](https://img.shields.io/badge/semantic--release-conventionalcommits-e10079?logo=semantic-release)](https://github.com/semantic-release/semantic-release)

[**Documentation**](https://psilvmoreira.github.io/localctl/) ·
[**Getting started**](https://psilvmoreira.github.io/localctl/getting-started/) ·
[**Releases**](https://github.com/psilvmoreira/localctl/releases) ·
[**Report a bug**](https://github.com/psilvmoreira/localctl/issues/new)

</div>

```console
$ npm install -g @localctl/cli
$ localctl setup
$ cd my-app && localctl app new && localctl app up

ok my-app -> https://my-app.local.test
```

---

## Table of contents

- [Why localctl](#why-localctl)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Supported container engines](#supported-container-engines)
  - [Updating](#updating)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Addons](#addons)
- [How it works](#how-it-works)
- [Documentation](#documentation)
- [Releases and versioning](#releases-and-versioning)
- [Contributing](#contributing)
- [Uninstalling](#uninstalling)
- [License](#license)

## Why localctl

Running several apps on Kubernetes locally usually means port juggling, hand-written YAML,
self-signed certificate warnings, and slow rebuilds. `localctl` replaces all of that with one
JSON file per app.

| | |
|---|---|
| 🧩 **One cluster, one CLI** | A single [k3d](https://k3d.io) cluster runs every app you develop. No per-project Kubernetes setup. |
| 🌐 **A subdomain per app** | `orders.local.test`, `billing.local.test`, routed by Traefik. No `localhost:3000` vs `:3001`. |
| 🔒 **HTTPS by default** | A locally-trusted wildcard certificate (via [mkcert](https://github.com/FiloSottile/mkcert)). Green padlock, no browser warnings. |
| 📄 **Config, not YAML** | Each app has one `.local/config.json`. Every Kubernetes manifest is generated from it. |
| ⚡ **Fast inner loop** | [Tilt](https://tilt.dev) builds, deploys, and live-syncs changed files into the running container. |
| 🐞 **Debugger-friendly** | Debug ports forwarded to `localhost`. Node, Python, Go, Java and .NET patterns included. |
| 🗄️ **Databases in one line** | Postgres, Redis and MongoDB per app, from real Helm charts, with credentials injected as Secrets. |
| 🐳 **Podman first** | Podman quirks (BuildKit, insecure registry) are detected and handled automatically. Docker Desktop and Rancher Desktop support is [experimental](#supported-container-engines). |
| 🧹 **Clean uninstall** | `localctl uninstall` reverses everything `localctl setup` did. |

## Requirements

| Requirement | Notes |
|---|---|
| **macOS** or **Windows** | Windows commands run in PowerShell. |
| **Node.js 18+** | Needed to install the CLI from npm. |
| **Container engine** | [Podman Desktop](https://podman-desktop.io/), running. See [supported container engines](#supported-container-engines). |
| **Homebrew** or **winget** | Used once by `localctl setup` to install missing tools. |

`localctl setup` installs `k3d`, `kubectl`, `tilt`, `mkcert` and `helm` for you if they're missing.

### Supported container engines

| Engine | Status |
|---|---|
| [Podman Desktop](https://podman-desktop.io/) | ✅ Tested |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 🧪 Experimental — not yet tested |
| [Rancher Desktop](https://rancherdesktop.io/) | 🧪 Experimental — not yet tested |

Experimental engines are detected and should work, since k3d only needs a Docker-compatible API,
but they haven't been through a full test cycle yet. `localctl setup` and `localctl doctor` print
a warning when one is in use. If you try one, please
[report how it went](https://github.com/psilvmoreira/localctl/issues/new).

## Installation

```sh
npm install -g @localctl/cli
localctl setup
localctl doctor     # every line should read [ok]
```

`localctl setup` detects your container engine, installs missing tools, creates the cluster and
the local image registry, trusts the `*.local.test` certificate, and updates your hosts file. It
is idempotent: run it again any time to repair your environment.

You'll see up to two one-time prompts during setup: **mkcert** asking to trust its local
certificate authority, and **sudo/Administrator** to write the `*.local.test` hosts entries.

**Pre-releases** are published under the `beta` tag: `npm install -g @localctl/cli@beta`.

### Updating

`localctl` checks npm for a new version at most once a day, in the background, and tells you
when one is available:

```console
Update available: 0.2.0 -> 0.3.0
Run npm install -g @localctl/cli to update.
```

Update with `npm install -g @localctl/cli`. The check never slows a command down, is skipped in
CI, and can be turned off with `LOCALCTL_NO_UPDATE_CHECK=1`.

<details>
<summary><b>Getting <code>EACCES</code> on <code>npm install -g</code>?</b></summary>

npm's global directory isn't writable by your user, which is common on macOS when Node wasn't
installed through a version manager. Fix it once for every global install
([npm's documented fix](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)):

```sh
mkdir ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or ~/.bash_profile
source ~/.zshrc
```

</details>

<details>
<summary><b>Install from source</b> (to work on localctl itself)</summary>

```sh
git clone https://github.com/psilvmoreira/localctl.git
cd localctl/cli
npm install
npm install -g .
localctl setup
```

Or, without touching npm's global config, use the bootstrap scripts. They install a
self-contained shim in `~/.localctl/bin` and run `localctl setup` for you:

```sh
./bin/bootstrap.sh      # macOS
./bin/bootstrap.ps1     # Windows (PowerShell)
```

</details>

## Quick start

**1. Scaffold** — from inside your app's repository:

```sh
localctl app new
```

This asks for an app name and port, then creates `.local/config.json` and a `Tiltfile`.

**2. Deploy:**

```console
$ localctl app up
> Waiting for the deployment to become ready...
deployment "my-app" successfully rolled out

ok my-app -> https://my-app.local.test
  debug:  localhost:9229
  logs:   localctl app logs my-app -f
  status: localctl app status
  stop:   localctl app down
```

The dev loop runs in the background, so closing the terminal doesn't stop it. Edit a file under
a `sync` path and it updates in the running container without a full rebuild. Use
`localctl app up -f` for the interactive Tilt UI instead.

**3. Check on it:**

```console
$ localctl app status
APP     NAMESPACE  READY  URL                       DEV LOOP
my-app  my-app     1/1    https://my-app.local.test  running (pid 4815)
```

**4. Stop it:**

```sh
localctl app down
```

This removes only that app. The shared cluster keeps running for everything else.

> **Tip:** no app of your own yet? Clone the repo and try a ready-made example:
> [`node-app`](https://github.com/psilvmoreira/localctl/tree/master/examples/node-app) (Node.js + Postgres),
> [`python-app`](https://github.com/psilvmoreira/localctl/tree/master/examples/python-app) (Python + Redis), or
> [`dotnet-api`](https://github.com/psilvmoreira/localctl/tree/master/examples/dotnet-api) (.NET).

## Commands

Run `localctl <command> --help` for every option.

<details open>
<summary><b>Machine setup</b></summary>

| Command | Description |
|---|---|
| `localctl setup` | Install or repair the infrastructure: container engine, cluster, TLS, hosts. Idempotent. |
| `localctl doctor` | Health check of the active project's environment. |
| `localctl hosts sync` / `list` | Manage the `*.local.test` entries in your hosts file. |
| `localctl uninstall [-y]` | Remove every cluster, registry, hosts entry, certificate and state file `localctl` created. |

</details>

<details open>
<summary><b>Apps</b></summary>

| Command | Description |
|---|---|
| `localctl app new` | Scaffold `.local/config.json` and a `Tiltfile` in the current repository. |
| `localctl app up [-f]` | Build, deploy and live-reload the app. Background by default; `-f` for the Tilt UI. |
| `localctl app down` | Stop the dev loop and remove the app. Keeps its data. |
| `localctl app reload [-a <name>]` | Force a rebuild and redeploy without waiting for a file change. |
| `localctl app status [-a <name>] [-A]` | One app's detail inside its repository, or a table of every app. |
| `localctl app logs <name> [-f]` | Show or follow an app's logs. |
| `localctl app exec [cmd...]` | Open a shell (default `sh`) in the app's pod. |
| `localctl app prune [-y]` | Delete leftover data (volumes, secrets) of apps already taken down. |
| `localctl app secrets set <KEY> [value]` | Store a secret as a Kubernetes Secret, never in `config.json`. |
| `localctl app secrets list` / `show [KEY]` / `unset <KEY>` | List, reveal or remove secrets. |

</details>

<details open>
<summary><b>Addons and projects</b></summary>

| Command | Description |
|---|---|
| `localctl addons list` / `status` | Show available addons and what is running in the cluster. |
| `localctl addons enable <name>` / `disable <name>` | Turn a cluster-wide addon (`logging`, `monitoring`) on or off. |
| `localctl profiles new <name>` | Create an isolated project: its own cluster, or a namespace in an existing one. |
| `localctl profiles list` / `status` | Show every project, or the active one. |
| `localctl profiles switch <name>` | Make a project active and start its cluster if needed. |

</details>

## Configuration

Everything about how an app runs locally lives in its `.local/config.json`:

```json
{
  "name": "orders-api",
  "subdomain": "orders",
  "port": 3000,
  "build": { "context": ".", "dockerfile": "Dockerfile" },
  "env": { "NODE_ENV": "development" },
  "debug": { "enabled": true, "port": 9229, "type": "node" },
  "dependencies": [{ "type": "postgres", "database": "orders" }],
  "sync": [{ "localPath": "./src", "remotePath": "/app/src" }],
  "tls": true
}
```

This deploys `orders-api` at `https://orders.local.test`, with its own Postgres instance and the
Node.js debugger on `localhost:9229`.

A [JSON Schema](https://github.com/psilvmoreira/localctl/blob/master/schema/app.schema.json) is
available for editor autocomplete and validation. Full field reference:
[**Config schema**](https://psilvmoreira.github.io/localctl/config-schema/).

## Addons

Every addon is one `addon.yaml` file pointing at a published Helm chart. No code required.

| Addon | Scope | Enable with | Chart |
|---|---|---|---|
| `postgres` | Per app | `"dependencies": [{ "type": "postgres" }]` | Bitnami |
| `redis` | Per app | `"dependencies": [{ "type": "redis" }]` | Bitnami |
| `mongo` | Per app | `"dependencies": [{ "type": "mongo" }]` | Bitnami |
| `logging` | Cluster | `localctl addons enable logging` → `https://grafana.local.test` | Grafana `loki-stack` |
| `monitoring` | Cluster | `localctl addons enable monitoring` → `https://monitoring.local.test` | `prometheus-community` |

Per-app dependencies get their connection details injected into the app container, and a
`wait-for-<type>` init container so the app never starts before its database is ready.
To add your own addon, see [**Adding tools**](https://psilvmoreira.github.io/localctl/adding-tools/).

## How it works

```
 .local/config.json ──► localctl ──► Kubernetes manifests ──► Tilt ──► k3d cluster
   (your app repo)     validates      (generated, never        builds,     Traefik ingress
                       + generates     hand-written)           pushes,     + local registry
                                                               live-syncs  + *.local.test TLS
```

`localctl` validates the config, generates every manifest, and manages the cluster lifecycle.
Tilt handles the build, push and live-sync loop. Full breakdown, including multi-project support
and Podman handling: [**Architecture**](https://psilvmoreira.github.io/localctl/architecture/).

## Documentation

The full documentation lives at **[psilvmoreira.github.io/localctl](https://psilvmoreira.github.io/localctl/)**.

| Guide | What's inside |
|---|---|
| [Getting started](https://psilvmoreira.github.io/localctl/getting-started/) | Install and first deploy, step by step |
| [Architecture](https://psilvmoreira.github.io/localctl/architecture/) | Every component, why it was chosen, multi-project support |
| [Config schema](https://psilvmoreira.github.io/localctl/config-schema/) | Every `.local/config.json` field |
| [Debugging](https://psilvmoreira.github.io/localctl/debugging/) | Attach a debugger in Node, Python, Go, Java and .NET |
| [Adding tools](https://psilvmoreira.github.io/localctl/adding-tools/) | Write your own per-app or cluster-wide addon |
| [Troubleshooting](https://psilvmoreira.github.io/localctl/troubleshooting/) | Known issues, with cause and fix |
| [Uninstalling](https://psilvmoreira.github.io/localctl/uninstalling/) | Full teardown reference |
| [Releasing](https://psilvmoreira.github.io/localctl/releasing/) | How versions are cut and published |

## Releases and versioning

- Releases are fully automated: every merge to `master` is analysed by
  [semantic-release](https://github.com/semantic-release/semantic-release), which picks the next
  version, publishes to npm and creates a [GitHub Release](https://github.com/psilvmoreira/localctl/releases)
  with notes and the package tarball.
- Versions follow [Semantic Versioning](https://semver.org). Before `1.0.0`, minor versions may
  contain breaking changes.
- npm releases are published from GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements). The npm package page links
  each version to the exact commit and workflow run that built it.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository and create a branch.
2. Make your change and run the tests:
   ```sh
   cd cli
   npm ci
   npm test            # every command loads, --version is correct
   npm run test:pack   # the published package installs and runs
   ```
3. Open a pull request with a [Conventional Commits](https://www.conventionalcommits.org/) title.
   The title decides the next version:

   | Title | Release |
   |---|---|
   | `fix: ...` | Patch (`0.2.0` → `0.2.1`) |
   | `feat: ...` | Minor (`0.2.1` → `0.3.0`) |
   | `feat!: ...` | Major (`0.3.0` → `1.0.0`) |
   | `docs:` `chore:` `ci:` `refactor:` `test:` | No release |

<details>
<summary><b>Repository layout</b></summary>

```
localctl/
├── cli/                 the localctl CLI (published to npm as @localctl/cli)
│   ├── bin/             executable entry point
│   ├── src/commands/    one file per command
│   ├── src/lib/         config validation, manifest generation, cluster/hosts/Podman handling
│   │   └── addons/      built-in addons (postgres, redis, mongo, logging, monitoring)
│   ├── templates/       Tiltfile copied into apps by `localctl app new`
│   └── scripts/         packaging and test scripts
├── cluster/manifests/   cluster-level manifests (TLS store, addon namespace)
├── schema/              JSON Schema for .local/config.json
├── examples/            ready-to-run sample apps
├── docs/                documentation site (MkDocs Material, deployed to GitHub Pages)
└── bin/                 bootstrap and uninstall scripts for source installs
```

</details>

## Uninstalling

```sh
localctl uninstall              # clusters, registries, hosts entries, certificates, state
npm uninstall -g @localctl/cli  # the CLI itself
```

`localctl uninstall` asks for confirmation (skip with `-y`) and is safe to re-run. It leaves the
shared tools (`k3d`, `kubectl`, `tilt`, `mkcert`, `node`) and mkcert's root CA installed, since
other projects may use them. It prints the exact commands to remove them too. Installed from
source with the bootstrap script? Use `./bin/uninstall.sh` or `./bin/uninstall.ps1` instead.
Details: [**Uninstalling**](https://psilvmoreira.github.io/localctl/uninstalling/).

## License

[MIT](https://github.com/psilvmoreira/localctl/blob/master/LICENSE) © Pedro Moreira
