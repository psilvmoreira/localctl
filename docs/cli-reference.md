---
description: Every localctl command, its options, and what it does.
---

# CLI commands

Every command prints its own options with `--help`, for example `localctl app up --help`.

Commands under `app` act on the app in the current directory, described by its
`.local/config.json`. Run them from the app's repository root. Everything else acts on the
[active project](getting-started.md#5-more-than-one-project).

## Machine setup

| Command | Description |
|---|---|
| `localctl setup` | Install or repair the `default` project's infrastructure: container engine check, tools (`k3d`, `kubectl`, `tilt`, `mkcert`, `helm`), k3d cluster, local registry, TLS certificate and hosts file. Idempotent: safe to re-run any time. |
| `localctl doctor` | Health check of the active project's environment. Every line should read `[ok]`. |
| `localctl uninstall` | Remove everything `setup` and `profiles` created: every project's cluster, registries, hosts entries, certificates and state. See [Uninstalling](uninstalling.md). |
| `localctl hosts sync` | Write every registered app subdomain into the hosts file. |
| `localctl hosts list` | List the registered subdomains. |

| Option | Command | Description |
|---|---|---|
| `-y`, `--yes` | `uninstall` | Skip the confirmation prompt. |

## Apps

| Command | Description |
|---|---|
| `localctl app new` | Scaffold `.local/config.json` and a `Tiltfile` in the current repository. |
| `localctl app up` | Build, deploy and live-reload the app. Runs in the background and survives closing the terminal. |
| `localctl app down` | Stop the dev loop and remove the app from the cluster. Keeps its data (database volumes, secrets). |
| `localctl app reload` | Force a rebuild and redeploy without waiting for a file change. |
| `localctl app status` | Inside an app repo: that app's readiness, URL, debug port, dependencies and dev-loop state. Elsewhere: a table of every app. |
| `localctl app logs [name]` | Show an app's logs. Resolves the app from the current directory when no name is given. |
| `localctl app exec [cmd...]` | Run a command in the app's pod. Opens `sh` when no command is given. |
| `localctl app prune` | Permanently delete the leftover data (volumes, secrets) of apps already taken down. |

| Option | Command | Description |
|---|---|---|
| `-f`, `--foreground` | `app up` | Run in the foreground with the interactive Tilt UI. ++ctrl+c++ stops the app. |
| `-a`, `--app <name>` | `app status`, `app reload` | Act on one app by name, from any directory. |
| `-A`, `--all` | `app status` | Show the table of every app, even from inside an app repo. |
| `-f`, `--follow` | `app logs` | Keep streaming new log lines. |
| `-n`, `--namespace <ns>` | `app logs` | Override the namespace. Only needed outside the app's repo. |
| `-y`, `--yes` | `app prune` | Skip the confirmation prompt. |

### Secrets

The app's own secrets (API keys, tokens). Values are stored as Kubernetes Secrets, never in
`.local/config.json`. See [Config schema: secrets](config-schema.md#secrets).

| Command | Description |
|---|---|
| `localctl app secrets set <KEY> [value]` | Set a secret. Prompts with hidden input when no value is given. |
| `localctl app secrets unset <KEY>` | Remove a secret. |
| `localctl app secrets list` | List which keys are set, without their values. |
| `localctl app secrets show [KEY]` | Print secret values to the terminal. |

## Addons

Cluster-wide addons for the active project. Per-app databases are not managed here: declare them
in the app's `dependencies` instead. See [Adding tools](adding-tools.md).

| Command | Description |
|---|---|
| `localctl addons list` | List the available cluster-wide addons. |
| `localctl addons enable <name>` | Install an addon, e.g. `logging` (Grafana at `https://grafana.local.test`) or `monitoring`. |
| `localctl addons disable <name>` | Remove an addon. |
| `localctl addons status` | Show every addon instance running in the cluster. |

## Projects

Isolated environments: a separate cluster, or a namespace inside an existing one. See
[Getting started: more than one project](getting-started.md#5-more-than-one-project).

| Command | Description |
|---|---|
| `localctl profiles new <name>` | Create a project and mark the current directory as belonging to it. |
| `localctl profiles list` | List every project, grouped by the cluster that runs it. |
| `localctl profiles switch <name>` | Make a project active. Starts its cluster if needed. |
| `localctl profiles status` | Show the active project. |

## Internal commands

The generated `Tiltfile` calls these. You don't need to run them yourself, but they help when
debugging what gets deployed.

| Command | Description |
|---|---|
| `localctl app generate-manifests` | Print the Kubernetes manifests generated for the current app. |
| `localctl app registry-info` | Print the app's image registry push and pull addresses as JSON. |
| `localctl hosts clear` | Remove the whole managed `*.local.test` block from the hosts file. Used by `uninstall`. |

## Environment variables

| Variable | Effect |
|---|---|
| `LOCALCTL_NO_UPDATE_CHECK=1` | Turn off the daily check for a newer `@localctl/cli` on npm. The check is also skipped in CI and when output is not a terminal. |
