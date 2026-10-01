# localctl

📖 **[Full documentation site](https://psilvmoreira.github.io/localctl/)** — same content as
below, plus diagrams, search, and a nicer read. Update the `USERNAME`/`repo_url` placeholders in
`mkdocs.yml` and this line once this repo has a real GitHub remote (see [Docs
Site](#docs-site) below for how it's built/deployed).

A local Kubernetes dev platform for macOS and Windows: one shared cluster, one `*.local.test`
subdomain per app, config-driven deploys, live-reload via Tilt, HTTPS everywhere, and a single
CLI — `localctl` — that owns the whole lifecycle from first install to full teardown.

Point it at any app repo, describe the app in a small JSON file, and `localctl app up` builds it,
deploys it, wires up its subdomain and TLS certificate, and live-syncs your code on every save.

```
$ localctl app up
ok orders-api -> https://orders.local.test
```

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installing the CLI](#installing-the-cli)
- [Quickstart: deploy your first app](#quickstart-deploy-your-first-app)
- [CLI reference](#cli-reference)
- [App configuration](#app-configuration)
- [Multiple projects](#multiple-projects)
- [Architecture](#architecture)
- [Debugging](#debugging)
- [Adding tools (databases, logging, more)](#adding-tools-databases-logging-more)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Repo layout](#repo-layout)
- [Documentation index](#documentation-index)
- [Docs Site](#docs-site)

## Features

- **One cluster, one CLI.** A single k3d (k3s-in-Docker) cluster runs every app you're developing
  locally. No per-project Kubernetes setup, no VM sprawl.
- **A real subdomain per app.** `myapp.local.test`, `orders.local.test`, whatever you name it —
  routed by Traefik, no port-juggling, no `localhost:3000` vs `localhost:3001` confusion.
- **HTTPS by default.** A locally-trusted wildcard certificate (via `mkcert`) is wired into the
  cluster's ingress automatically. Every app gets a green padlock, not a browser warning.
- **Config-driven, not YAML-driven.** Each app repo gets one `.local/config.json`. `localctl`
  generates every Kubernetes manifest from it — you never hand-write or hand-edit Kubernetes YAML.
- **Fast inner loop.** Tilt builds your image, pushes it to a local registry, deploys it, and
  live-syncs changed files straight into the running container — no full rebuild for every edit.
- **Debugger-friendly.** Declare a debug port in config and it's forwarded to `localhost`
  automatically. Node, Python, Go, Java, and .NET patterns are documented and ready to copy.
- **Cross-platform, including Podman.** Works with Docker Desktop, Podman Desktop, or Rancher
  Desktop. Podman-specific quirks (BuildKit protocol, insecure-registry trust) are detected and
  handled automatically — you don't need to know they exist.
- **Real Helm charts, zero JS.** Per-app databases (Postgres, Redis, MongoDB via Bitnami's own
  charts) and cluster-wide addons (a Grafana/Loki logging stack, a Prometheus metrics stack) are
  each just one `addon.yaml` file pointing at a published chart — adding a new one is dropping in
  a folder, no code required. Each dependency also gets a `wait-for-<type>` init container
  automatically, so your app never races one that isn't ready yet.
- **Real readiness, not just "the process started."** Every app gets a TCP (or HTTP, if you set a
  path) readiness/liveness probe by default — `kubectl rollout status` succeeding actually means
  it's serving.
- **Your own secrets, never plaintext.** API keys and tokens you supply (not addon-generated
  credentials) go through the same real-Secret/`secretKeyRef` pipeline — `localctl app secrets
  set/show` to write and read them, `.local/config.json` only ever holds the key name.
- **Clean install, clean uninstall.** Nothing is installed with `sudo`-requiring global state where
  avoidable, and `localctl uninstall` reverses everything `localctl setup` did.
- **More than one project when you need it.** `default` (one shared cluster) is all most people
  ever need, but `localctl profiles new` can spin up an isolated project - either its own separate
  cluster, or just a namespace-scoped slice of an existing one - and directory-based resolution
  (walk up for the nearest `.local/project.json`, same idea as `.git`/`.claude`) means `app`
  commands just know which project they're in.

## Requirements

- **macOS** or **Windows** (PowerShell)
- One running container engine: **Docker Desktop**, **Podman Desktop**, or **Rancher Desktop**
- **Git**, to clone this repo and your app repos
- **Homebrew** (macOS) or **winget** (Windows) — used once to install missing tools

Everything else (`k3d`, `kubectl`, `tilt`, `mkcert`, `helm`, Node.js) is installed automatically if it's
missing.

## Installing the CLI

**From npm (recommended):**

```
npm install -g @localctl/cli
localctl setup
```

Pre-releases (from the `beta` branch) are published under the `beta` dist-tag: `npm install -g @localctl/cli@beta`.

**From source** (to hack on `localctl` itself):

1. Clone this repo somewhere permanent (it acts as the control plane for every app you run
   locally, so keep it around — don't nest it inside an app repo):

   ```
   git clone <this-repo-url> ~/dev/localctl
   cd ~/dev/localctl
   ```

2. Install `localctl` as a standard global npm package:

   ```
   cd cli
   npm install
   npm install -g .
   ```

   > **Hit `EACCES`?** That means npm's global install directory isn't writable by your user —
   > common on macOS when Node wasn't installed through a version manager. Fix it once, for every
   > future global npm install, not just this one ([npm's own documented fix](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)):
   > ```
   > mkdir ~/.npm-global
   > npm config set prefix ~/.npm-global
   > echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or ~/.bash_profile
   > source ~/.zshrc
   > ```
   > Then re-run `npm install -g .` from `cli/`.

3. Run the actual infra setup:

   ```
   localctl setup
   ```

   This detects your container engine, installs `k3d`/`kubectl`/`tilt`/`mkcert`/`helm` if missing,
   creates the local cluster, starts the local image registry, generates and trusts the
   `*.local.test` TLS certificate, and syncs your hosts file.

   You'll see up to two password prompts during this step — both expected, both one-time:
   - **mkcert** asking to trust its local certificate authority (macOS Touch ID/password prompt)
   - **sudo/Administrator** asking to write the `*.local.test` entries to your hosts file

4. Confirm it worked:

   ```
   localctl doctor
   ```

   Every line should read `[ok]`.

From here on, `localctl` is a normal globally-installed command:

```
localctl setup    # re-check or repair the infra at any time — fully idempotent
localctl uninstall    # tear the infra back down (see Uninstalling below)
```

<details>
<summary>Alternative: install without touching npm's global config</summary>

If you'd rather not change npm's global prefix, `bin/bootstrap.sh` (macOS) / `bootstrap.ps1`
(Windows) install `localctl` as a self-contained PATH shim in `~/.localctl/bin` instead of a real
npm global package — no `npm install -g`, no `EACCES` possible, same `localctl` command either
way:

```
./bin/bootstrap.sh        # macOS — installs the shim, then runs `localctl setup` for you
./bin/bootstrap.ps1        # Windows (PowerShell)
```

Uninstall the shim version with `./bin/uninstall.sh` / `uninstall.ps1` instead of
`npm uninstall -g` (see [Uninstalling](#uninstalling)).
</details>

## Quickstart: deploy your first app

Try it immediately with the bundled example, no app of your own required:

```
cd examples/node-app
localctl app up
```

`localctl app up` runs in the background by default — it prints the app's real URL once the
deployment is ready and hands control of the terminal straight back to you, so closing that
terminal doesn't stop the app:

```
$ localctl app up
> Waiting for the deployment to become ready...
deployment "node-app" successfully rolled out

ok node-app -> https://node-app.local.test
  debug:  localhost:9229
  logs:   localctl app logs node-app -f
  status: localctl app status
  stop:   localctl app down
```

Open <https://node-app.local.test>. Live-sync keeps working in the background exactly as if it
were running in the foreground — edit a file under any path listed in `"sync"` and it updates
without a full rebuild, as long as something inside the container watches for the change and
restarts (`nodemon`, `uvicorn --reload`, etc. — see [Debugging](#debugging) and
`examples/node-app/Dockerfile` for a working pattern).

Want the interactive Tilt UI instead (build logs streaming live in your terminal)? Add `-f`:

```
localctl app up -f
```

To use it with your own app:

1. From inside your app's repo:

   ```
   localctl app new
   ```

   This scaffolds `.local/config.json` and a generic `Tiltfile`. `localctl app new` asks for an app
   name and port; edit `.local/config.json` afterward for anything else (env vars, database
   dependencies, debug settings — see [App configuration](#app-configuration)).

2. Deploy it: `localctl app up` (see above).

3. Check on it any time. Run from inside the app's own repo (or `-a <name>` from anywhere) for
   that app's detail:

   ```
   $ localctl app status
   node-app
     namespace: node-app
     ready:     1/1
     url:       https://node-app.local.test
     debug:     localhost:9229
     dev loop:  running (pid 4815)
     dependencies:
       node-app-postgres  1/1
   ```

   From anywhere else (or with `-A`/`--all`), it's a table of every app:

   ```
   $ localctl app status
   APP       NAMESPACE  READY  URL                         DEV LOOP
   node-app  node-app   1/1    https://node-app.local.test  running (pid 4815)
   ```

4. When you're done:

   ```
   localctl app down
   ```

   Stops the background dev loop (if any) and tears down just this app; the shared cluster keeps
   running for everything else.

## CLI reference

| Command | Purpose |
|---|---|
| `localctl setup` | Install/repair the `default` project's infra (container engine, cluster, TLS, hosts). Idempotent. |
| `localctl uninstall [-y]` | Remove everything `setup`/`profiles` set up: every project's cluster, registries, hosts entries, certs/state. |
| `localctl doctor` | Quick health check of the active project's environment. |
| `localctl app new` | Scaffold `.local/config.json` + `Tiltfile` in the current app repo. |
| `localctl app up [-f]` | Build, deploy, and live-reload the app in the current directory. Runs detached in the background by default (survives closing the terminal) and prints the app's URL once ready; `-f`/`--foreground` runs the interactive Tilt UI instead. |
| `localctl app down` | Stop the background dev loop (if any) and tear down the app deployed from the current directory. |
| `localctl app reload [-a <name>]` | Force an immediate rebuild/redeploy of a running background dev loop, without waiting on a file change. |
| `localctl app status [-a <name>] [-A]` | App detail (readiness, URL, debug port, dependencies, dev-loop state) when run inside an app repo or with `-a <name>`; a table of every app otherwise, or always with `-A`/`--all`. |
| `localctl app logs <name> [-f]` | Tail logs for a deployed app. |
| `localctl app exec [cmd...]` | Shell into the running app's pod (`kubectl exec`); defaults to `sh`. |
| `localctl app prune [-y]` | Permanently delete an already-torn-down app's leftover data (dependency PVCs, secrets) - `app down` deliberately leaves these alone. |
| `localctl app secrets set <KEY> [value]` | Set your own secret value (hidden prompt if not given inline) - stored as a real k8s Secret, never in `.local/config.json`. |
| `localctl app secrets list` / `show [KEY]` / `unset <KEY>` | List which keys are set, reveal actual value(s), or remove one. |
| `localctl hosts sync` / `list` | Manage the `*.local.test` entries in your hosts file. |
| `localctl addons list` / `enable <name>` / `disable <name>` | Manage cluster-wide addons (e.g. `logging`, `monitoring`). |
| `localctl addons status` | Every addon instance in the active project's cluster — per-app dependencies and cluster-wide addons — shown separately from your actual apps. |
| `localctl profiles new <name>` | Create a project - its own cluster (Main project), or namespace-scoped under an existing one. |
| `localctl profiles list` | List every project this machine knows about, nested under its Main (cluster) project. |
| `localctl profiles switch <name>` | Make a project active - brings its cluster up if needed, applies its exclusive-teardown setting. |
| `localctl profiles status` | Show the currently active project. |

Run `localctl <command> --help` for options on any of these.

## App configuration

Everything about how an app deploys locally lives in that app repo's `.local/config.json`:

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

This resolves to `https://orders.local.test`, with a dedicated Postgres instance deployed
alongside it. Point your editor's JSON schema support at `schema/app.schema.json` for
autocomplete and validation as you type — `localctl app new` sets this up automatically via
`"$schema"`.

Full field-by-field reference: **[docs/config-schema.md](./docs/config-schema.md)**.

## Multiple projects

`default` is one shared cluster for everything - fine until you need real isolation (a second
client's stack, a "staging-like" environment, or just apps you don't want sharing a cluster with
your main work). From the folder you want it to apply to:

```
localctl profiles new staging
```

Choose either your own cluster (a Main project) or a namespace-scoped slice of an existing one, and
it writes `.local/project.json` there - every app under that folder, and any subfolder below it,
now resolves to `staging` automatically, the same directory walk-up `.git`/`.claude` use.
`localctl profiles list` / `status` / `switch <name>` manage which project is current.

Full mechanism (exclusive vs. concurrent clusters, namespace scoping, port handling):
**[docs/architecture.md#multi-project-support](./docs/architecture.md#multi-project-support)**.

## Architecture

k3d cluster (Traefik ingress + local registry) → Tilt (build, push, live-sync) → `localctl`
(config validation, manifest generation, infra lifecycle) → your app repo's
`.local/config.json`. Nothing about an app's Kubernetes shape is hand-written; it's all generated
from that one file by `cli/src/lib/manifestGen.js`.

Full breakdown of every component and why it was chosen (including the Podman-specific handling):
**[docs/architecture.md](./docs/architecture.md)**.

## Debugging

Set `"debug": { "enabled": true, "port": <port>, "type": "<node|python|go|java|dotnet>" }` in
`.local/config.json` and the port is forwarded to `localhost` automatically while `localctl app up` is
running — attach your debugger like you would to any local process. Per-language Dockerfile and
`launch.json` patterns (including the live-reload watcher each language needs — `nodemon`,
`uvicorn --reload`, `air`, Spring Boot DevTools): **[docs/debugging.md](./docs/debugging.md)**.

## Adding tools (databases, logging, more)

Every addon is one folder with one `addon.yaml` pointing at a real, published Helm chart — no JS.

- **Per-app dependencies** (Postgres, Redis, MongoDB today, via Bitnami's own charts) are declared
  in an app's `"dependencies"` array and deployed alongside it, isolated per app, with connection
  details (host, port, credentials via a real k8s Secret) auto-injected into its container.
- **Cluster-wide addons**: `logging` (Grafana Labs' own loki-stack chart, at
  `https://grafana.local.test` once enabled, dashboard auto-provisioned from a file in the addon's
  `config/` folder) and `monitoring` (prometheus-community's own Prometheus chart, at
  `https://monitoring.local.test`) - shared infrastructure turned on once via `localctl addons
  enable <name>`.

Adding a new one — a message broker, a tracing backend, whatever's next — means finding its Helm
chart and writing one `addon.yaml`: **[docs/adding-tools.md](./docs/adding-tools.md)**.

## Uninstalling

```
localctl uninstall                          # every project's cluster/registry, Podman VM config, hosts entries, certs/state
npm uninstall -g @localctl/cli          # + the CLI itself, if you installed it via npm
./bin/uninstall.sh   # or uninstall.ps1      # + the CLI itself, if you installed it via bin/bootstrap.sh's shim
```

Prompts for confirmation (skip with `-y`/`--yes`); every step is best-effort and safe to re-run.
Deliberately left untouched: `k3d`/`kubectl`/`tilt`/`mkcert`/`node` themselves and mkcert's root CA
trust (other projects on your machine may depend on either) — both are printed with the exact
command to remove them yourself if you want them gone too.

Full details: **[docs/uninstalling.md](./docs/uninstalling.md)**.

## Troubleshooting

Hit something unexpected — a Podman-specific build/push error, a port conflict, a certificate
warning, `ImagePullBackOff`, stale live-sync? Check
**[docs/troubleshooting.md](./docs/troubleshooting.md)** first; it covers every issue found while
building and testing this repo, with the actual cause and fix for each.

## Repo layout

```
localctl/
├── bin/                  thin installer stubs (macOS + Windows) - install Node/the CLI, then
│                         hand off to `localctl setup`/`localctl uninstall`
├── cluster/              k3d cluster definition + cluster-level manifests (TLS store, namespaces)
├── cli/                  the localctl Node.js CLI
│   ├── src/commands/     one file per CLI subcommand (setup, uninstall, up, new, profiles, ...)
│   ├── src/lib/          config validation, manifest generation, project/cluster/Podman/hosts handling
│   │   └── addons/       per-app (postgres/redis/mongo) + cluster/ (logging, monitoring) addons
│   └── templates/        generic Tiltfile copied into app repos by `localctl app new`
├── schema/               JSON Schema for .local/config.json (editor autocomplete)
├── examples/             ready-to-run sample apps (Node.js + Postgres, Python + Redis, .NET)
└── docs/                 full documentation - also published as the docs site, see below
```

## Documentation index

- [docs/index.md](./docs/index.md) — documentation site home
- [docs/getting-started.md](./docs/getting-started.md) — the install/quickstart flow, in more detail
- [docs/architecture.md](./docs/architecture.md) — every component and why it was chosen, with diagrams
- [docs/config-schema.md](./docs/config-schema.md) — full `.local/config.json` reference
- [docs/adding-tools.md](./docs/adding-tools.md) — add new per-app or cluster-wide addons
- [docs/debugging.md](./docs/debugging.md) — attach a debugger, per language
- [docs/uninstalling.md](./docs/uninstalling.md) — full teardown reference
- [docs/troubleshooting.md](./docs/troubleshooting.md) — known issues and fixes

## Docs Site

Everything under `docs/` is also published as a [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/)
site — search, dark/light mode, and the Mermaid diagrams in [Architecture](./docs/architecture.md)
rendered properly (GitHub renders Mermaid too, but the site's theme is nicer for reading).

**One-time setup**, once this repo has a real GitHub remote:

1. In `mkdocs.yml`, replace every `USERNAME` with your GitHub username (or org), and in this
   README's link at the top.
2. Push to GitHub, then in the repo's **Settings → Pages**, set **Source** to **Deploy from a
   branch** and **Branch** to **`gh-pages`** / **`/ (root)`**. (The first push of
   `.github/workflows/docs.yml` below creates that branch for you — the option won't appear in the
   dropdown until after that first run.)

From then on, **every push to `master`** rebuilds and redeploys the site automatically
(`.github/workflows/docs.yml`) — nothing to run by hand.

To preview locally before pushing:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install mkdocs-material
mkdocs serve   # http://127.0.0.1:8000, live-reloads on save
```
