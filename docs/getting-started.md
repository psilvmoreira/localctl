# Getting Started

## 1. One-time machine setup

Clone this repo somewhere permanent — it stays on your machine as the control plane for every
app you run locally, separate from your app repos.

```
git clone <this-repo> ~/dev/localctl
cd ~/dev/localctl
```

Install `localctl` as a standard global npm package:

```
cd cli
npm install
npm install -g .
```

If that fails with `EACCES`, npm's global install directory isn't writable by your user — fix it
once, for every future global npm install, not just this one:

```
mkdir ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or ~/.bash_profile
source ~/.zshrc
```

Then re-run `npm install -g .` from `cli/`. This is [npm's own documented
fix](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally),
not a workaround specific to this repo.

Now run the actual setup:

```
localctl setup
```

This does everything:

1. Detects your container engine and confirms it's running. Podman Desktop is tested; Docker
   Desktop and Rancher Desktop are experimental and print a warning.
2. Installs anything missing: `k3d`, `kubectl`, `tilt`, `mkcert` (via Homebrew on macOS, winget on
   Windows).
3. Creates the `local-dev` k3d cluster, with ports 80/443 mapped to your machine, and starts a
   local image registry container (`localhost:5050` from your machine, `local-dev-registry:5000`
   from inside the cluster — see [Architecture](./architecture.md) for why it's a plain container
   and why the ports differ).
4. Generates a locally-trusted wildcard certificate for `*.local.test` via `mkcert` and wires it
   into Traefik as the cluster's default certificate.
5. Syncs your hosts file so `*.local.test` resolves. This is the step most likely to prompt you for
   a password (macOS `sudo`) or fail with a message telling you to run a command yourself in an
   elevated shell (Windows, if not run as Administrator) — that's expected, not a bug.

`localctl setup` is a normal command — run it directly any time you want to (re)check or
repair the infra (new machine state, cluster deleted by hand, etc). Every step is idempotent.
Use `localctl doctor` for a quick health check without re-running the full setup. `localctl setup`
only ever manages the `default` project - see [More than one project](#5-more-than-one-project)
below for anything else.

**Alternative, if you'd rather not touch npm's global config:** `./bin/bootstrap.sh` (macOS) /
`bootstrap.ps1` (Windows) install `localctl` as a self-contained PATH shim in `~/.localctl/bin`
instead of a real npm package, and then run `localctl setup` for you automatically. No
`npm install -g`, no possible `EACCES`. Uninstall that version with `bin/uninstall.sh` /
`uninstall.ps1` instead of `npm uninstall -g` later.

## 2. Add an app

Inside any app repo:

```
localctl app new
```

This asks for an app name and port, then writes:

- `.local/config.json` — the app's infra configuration (see [Config Schema](./config-schema.md))
- `Tiltfile` — a generic file that reads `.local/config.json`; you usually don't need to touch it

Edit `.local/config.json` to fit your app: environment variables, database dependencies, debug
settings, live-sync paths, your own secrets, readiness/liveness overrides — full reference:
[Config Schema](./config-schema.md). See `examples/node-app`, `examples/python-app`, and
`examples/dotnet-api` for filled-out examples.

Adding a `dependencies` entry (`postgres`/`redis`/`mongo`) gets you a real Helm-deployed database
alongside your app *and* a `wait-for-<type>` init container automatically — your app's own
container won't start until that database is actually accepting connections, so
`kubectl get pods` briefly showing `Init:0/1` right after `localctl app up` is normal, not stuck
(see [Troubleshooting](./troubleshooting.md#dependency-wait-for-it-never-finishes-pod-stuck-on-init01)
if it stays that way).

## 3. Run it

```
localctl app up
```

If `.local/config.json` declares any `secrets`, `localctl app up` refuses to deploy until every one
of them has a value set (`localctl app secrets set <KEY>` — see [Config
Schema](./config-schema.md#secrets)), rather than deploying a pod that would just fail to start.

This registers the app's subdomain, syncs your hosts file (may prompt for `sudo`/Administrator
the first time), and runs Tilt **in the background** — the command returns control of your
terminal as soon as the deployment is ready (its readiness probe passing, not just the process
starting — see [Config Schema](./config-schema.md#probes)), and prints the app's real URL:

```
> Waiting for the deployment to become ready...
deployment "node-app" successfully rolled out

ok node-app -> https://node-app.local.test
  debug:  localhost:9229
  logs:   localctl app logs node-app -f
  status: localctl app status
  stop:   localctl app down
```

Closing this terminal does **not** stop the app — the Tilt process is fully detached
(`PPID=1`, its own process group), so it survives independently. From here:

- Edit code under any path listed in `"sync"` → Tilt live-syncs it into the running container.
- Edit anything else (e.g. `package.json`, `Dockerfile`) → Tilt rebuilds the image and redeploys.
- `localctl app logs <name> -f` or `tail -f ~/.localctl/run/<name>.log` for the full Tilt output.
- `localctl app status` any time to see whether it's still running and get its URL back — run from
  inside the app's repo (or `-a <name>` from anywhere) for that app's detail (readiness, URL,
  debug port, dependencies, dev-loop state); from anywhere else it's a table of every app
  (`-A`/`--all` forces the table even from inside an app repo).

Want the interactive Tilt web UI streaming in your terminal instead? `localctl app up -f`
(`--foreground`) — this blocks the terminal like before, and stops the app on Ctrl+C, which is
sometimes exactly what you want while actively watching a build.

Syncing a file only copies it into the running container — it doesn't restart your process.
Something inside the container needs its own file-watcher to pick the change up: `nodemon` for
Node (see `examples/node-app/Dockerfile`), `uvicorn --reload`/`flask run --debug` for Python,
[`air`](https://github.com/air-verse/air) for Go, Spring Boot DevTools for Java. Without one,
"live-sync" just quietly does nothing until you restart `localctl app up`.

Visit `https://<subdomain>.local.test` (the `<subdomain>` is whatever you set in
`.local/config.json`, defaulting to the app name).

## 4. Tear down

```
localctl app down
```

Stops the background dev loop (if `localctl app up` started one) and removes the app's Kubernetes
resources. The cluster itself keeps running so other apps aren't affected.

## 5. More than one project

Everything above manages a single project, `default`. Need a second, isolated one — either its own
whole cluster, or just a namespace-scoped slice of an existing one? From inside the folder you want
it to apply to (a parent folder above several app repos, or a single app repo):

```
localctl profiles new staging
```

This asks whether it should own a new cluster or share an existing project's, then (for a new
cluster) whether switching to it should tear down other projects' clusters or run alongside them,
and which cluster-wide addons to enable. It registers the project and writes
`.local/project.json` in the current directory, marking every app under it as belonging to
`staging` from now on — `localctl app up`/`down`/`status` run from anywhere under that folder
resolve to it automatically, the same way `.local/config.json` resolution already worked, just one
level up (see [Architecture — Multi-project support](./architecture.md#multi-project-support)).

```
localctl profiles list      # every project, nested under its owning cluster
localctl profiles status    # the currently active one
localctl profiles switch staging   # make it active; brings its cluster up if needed
```

`localctl doctor`/`hosts`/`addons` (nothing tied to one app's directory) always act on whichever
project is currently active — switch to the one you mean first.

## Everyday commands

| Command | Purpose |
|---|---|
| `localctl setup` | (Re)install/repair the `default` project's infra - safe to re-run any time |
| `localctl uninstall` | Remove everything `setup`/`profiles` set up, every project (see [Uninstalling](./uninstalling.md)) |
| `localctl doctor` | Check the active project's environment health |
| `localctl app new` | Scaffold `.local/config.json` + Tiltfile in the current repo |
| `localctl app up [-f]` | Build, deploy, live-reload. Detached (background) by default; `-f`/`--foreground` for the interactive Tilt UI |
| `localctl app down` | Stop the background dev loop (if any) and tear down the current app |
| `localctl app reload [-a <name>]` | Force an immediate rebuild/redeploy, without waiting on a file change |
| `localctl app status [-a <name>] [-A]` | App detail inside its repo or with `-a <name>`; a table of every app otherwise (or always with `-A`) |
| `localctl app logs [name] [-f]` | Tail logs for an app - resolves automatically from inside its repo |
| `localctl app exec [cmd...]` | Shell into the running app's pod (defaults to `sh`) |
| `localctl app prune [-y]` | Permanently delete an already-torn-down app's leftover data (PVCs, secrets) |
| `localctl app secrets set/unset/list/show` | Manage the app's own secrets (API keys, tokens) |
| `localctl hosts sync` / `localctl hosts list` | Manage `*.local.test` hosts entries |
| `localctl addons list` / `enable` / `disable` | Manage cluster-wide addons (e.g. `logging`, `monitoring`) in the active project |
| `localctl addons status` | Every addon instance in the active project's cluster, shown separately from your apps |
| `localctl profiles new <name>` | Create a project - its own cluster, or namespace-scoped under an existing one |
| `localctl profiles list` / `status` | List every project, or show the currently active one |
| `localctl profiles switch <name>` | Make a project active - brings its cluster up if needed |
