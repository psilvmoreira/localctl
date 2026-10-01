---
description: A local Kubernetes dev platform for macOS and Windows
---

# Project-Infra

A local Kubernetes dev platform for macOS and Windows: one shared cluster, one `*.local.test`
subdomain per app, config-driven deploys, live-reload via Tilt, HTTPS everywhere, and a single
CLI — `localctl` — that owns the whole lifecycle from first install to full teardown.

Point it at any app repo, describe the app in a small JSON file, and `localctl app up` builds it,
deploys it, wires up its subdomain and TLS certificate, and live-syncs your code on every save.

```console
$ localctl app up
✔ orders-api -> https://orders.local.test
```

[Get started :material-arrow-right:](getting-started.md){ .md-button .md-button--primary }
[View on GitHub :fontawesome-brands-github:](https://github.com/USERNAME/Project-Infra){ .md-button }

## Why Project-Infra

<div class="grid cards" markdown>

-   :material-kubernetes:{ .lg .middle } __One cluster, one CLI__

    ---

    A single k3d (k3s-in-Docker) cluster runs every app you're developing locally. No
    per-project Kubernetes setup, no VM sprawl.

-   :material-web:{ .lg .middle } __A real subdomain per app__

    ---

    `myapp.local.test`, `orders.local.test` — routed by Traefik, no port-juggling, no
    `localhost:3000` vs `localhost:3001` confusion.

-   :material-lock-check:{ .lg .middle } __HTTPS by default__

    ---

    A locally-trusted wildcard certificate (via `mkcert`) is wired into the cluster's ingress
    automatically. Every app gets a green padlock, not a browser warning.

-   :material-file-code:{ .lg .middle } __Config-driven, not YAML-driven__

    ---

    Each app repo gets one `.local/config.json`. `localctl` generates every Kubernetes
    manifest from it — you never hand-write or hand-edit Kubernetes YAML.

-   :material-sync:{ .lg .middle } __Fast inner loop__

    ---

    Tilt builds your image, pushes it to a local registry, deploys it, and live-syncs changed
    files straight into the running container — no full rebuild for every edit.

-   :material-bug-check:{ .lg .middle } __Debugger-friendly__

    ---

    Declare a debug port in config and it's forwarded to `localhost` automatically. Node,
    Python, Go, Java, and .NET patterns are documented and ready to copy.

-   :material-docker:{ .lg .middle } __Cross-platform, including Podman__

    ---

    Works with Docker Desktop, Podman Desktop, or Rancher Desktop. Podman-specific quirks are
    detected and handled automatically — you don't need to know they exist.

-   :material-database:{ .lg .middle } __Real Helm charts, zero JS__

    ---

    Per-app databases and cluster-wide addons (logging, metrics) are each just one
    `addon.yaml` pointing at a published chart. Each dependency also gets an automatic
    `wait-for-<type>` init container.

-   :material-heart-pulse:{ .lg .middle } __Real readiness__

    ---

    Every app gets a TCP (or HTTP) readiness/liveness probe by default — a successful rollout
    actually means it's serving, not just that the process started.

-   :material-key-variant:{ .lg .middle } __Your own secrets, never plaintext__

    ---

    API keys and tokens you supply go through the same real-Secret/`secretKeyRef` pipeline as
    addon-generated credentials — `.local/config.json` only ever holds the key name.

-   :material-broom:{ .lg .middle } __Clean install, clean uninstall__

    ---

    Nothing is installed with `sudo`-requiring global state where avoidable, and
    `localctl uninstall` reverses everything `localctl setup` did.

-   :material-source-branch:{ .lg .middle } __Multi-project when you need it__

    ---

    `localctl profiles new` spins up an isolated project — its own cluster, or a
    namespace-scoped slice of an existing one — resolved automatically by directory, the same
    way `.git`/`.claude` work.

</div>

## Requirements

- **macOS** or **Windows** (PowerShell)
- One running container engine: **Docker Desktop**, **Podman Desktop**, or **Rancher Desktop**
- **Git**, to clone this repo and your app repos
- **Homebrew** (macOS) or **winget** (Windows) — used once to install missing tools

!!! note "Everything else is automatic"
    `k3d`, `kubectl`, `tilt`, `mkcert`, `helm`, and Node.js are all installed for you if missing.

## Install in three commands

```bash
git clone <this-repo-url> ~/dev/Project-Infra && cd ~/dev/Project-Infra/cli
npm install && npm install -g .
localctl setup
```

!!! tip "Hit `EACCES` on `npm install -g`?"
    That means npm's global install directory isn't writable by your user. Full fix, and an
    alternative install method that avoids touching npm's global config entirely, in
    [Getting Started](getting-started.md).

Then, from any app repo:

```bash
localctl app new   # scaffold .local/config.json + Tiltfile
localctl app up    # build, deploy, live-reload
```

Or try it immediately with a bundled example — no app of your own required:

```bash
cd examples/node-app
localctl app up
```

[Full quickstart walkthrough :material-arrow-right:](getting-started.md){ .md-button }

## CLI reference

| Command | Purpose |
|---|---|
| `localctl setup` | Install/repair the `default` project's infra (container engine, cluster, TLS, hosts). Idempotent. |
| `localctl uninstall [-y]` | Remove everything `setup`/`profiles` set up: every project's cluster, registries, hosts entries, certs/state. |
| `localctl doctor` | Quick health check of the active project's environment. |
| `localctl app new` | Scaffold `.local/config.json` + `Tiltfile` in the current app repo. |
| `localctl app up [-f]` | Build, deploy, and live-reload the app in the current directory. Detached by default; `-f`/`--foreground` for the interactive Tilt UI. |
| `localctl app down` | Stop the background dev loop (if any) and tear down the app deployed from the current directory. |
| `localctl app reload [-a <name>]` | Force an immediate rebuild/redeploy without waiting on a file change. |
| `localctl app status [-a <name>] [-A]` | App detail, or a table of every app. |
| `localctl app logs [name] [-f]` | Tail logs for a deployed app — resolves automatically from inside its repo. |
| `localctl app exec [cmd...]` | Shell into the running app's pod (`kubectl exec`); defaults to `sh`. |
| `localctl app prune [-y]` | Permanently delete an already-torn-down app's leftover data. |
| `localctl app secrets set/unset/list/show` | Manage the app's own secrets (API keys, tokens). |
| `localctl hosts sync` / `list` | Manage the `*.local.test` entries in your hosts file. |
| `localctl addons list` / `enable <name>` / `disable <name>` / `status` | Manage cluster-wide addons (`logging`, `monitoring`). |
| `localctl profiles new/list/switch/status` | Manage projects — isolated clusters or namespace-scoped slices of one. |

Run `localctl <command> --help` for options on any of these.

## Where to go next

<div class="grid cards" markdown>

-   :material-rocket-launch:{ .lg .middle } __[Getting Started](getting-started.md)__

    ---

    Install the CLI, deploy your first app, and set up more than one project.

-   :material-sitemap:{ .lg .middle } __[Architecture](architecture.md)__

    ---

    Every component, why it was chosen, and diagrams of how they fit together.

-   :material-code-json:{ .lg .middle } __[Config Schema](config-schema.md)__

    ---

    Full `.local/config.json` reference — secrets, probes, sidecars, dependencies.

-   :material-puzzle:{ .lg .middle } __[Adding Tools](adding-tools.md)__

    ---

    Add a new database or cluster-wide addon with one `addon.yaml` file.

-   :material-bug:{ .lg .middle } __[Debugging](debugging.md)__

    ---

    Attach a debugger per language — Node, Python, Go, Java, .NET.

-   :material-wrench:{ .lg .middle } __[Troubleshooting](troubleshooting.md)__

    ---

    Known issues and fixes, with the actual root cause for each.

</div>
