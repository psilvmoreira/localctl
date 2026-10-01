# Troubleshooting

## `localctl app up`/`generate-manifests` fails with a `helm` error

Per-app database dependencies (`postgres`/`redis`/`mongo`) and cluster-wide addons are real Helm
charts, pulled from their real chart repos on first use (`cli/src/lib/addonLoader.js`). This means:

- **It needs network access** the first time a given chart+version is used (results are cached by
  Helm afterward, per its own local cache — subsequent runs work offline).
- **Bitnami's chart repo redirects through Broadcom's infrastructure** (`charts.bitnami.com` →
  `repo.broadcom.com`) since VMware/Bitnami's acquisition — this works as of writing but Broadcom
  has been actively restructuring free access to these charts, so if `postgres`/`redis`/`mongo`
  suddenly stop resolving, check `cli/src/lib/addons/<type>/addon.yaml`'s `chart.repo` first; it
  may need pointing at a different Postgres/Redis/MongoDB chart entirely.
- **A `helm template failed` error names the actual chart problem** — usually a values field that
  doesn't exist for the version pinned in that addon's `addon.yaml` (chart maintainers do rename
  values between major versions). Check `helm show values <repo>/<chart> --version <version>`
  against what the addon's `values:` block sets.

## Pod keeps restarting (`CrashLoopBackOff`) right after it starts serving

Every app gets a `readinessProbe`/`livenessProbe` by default - a plain TCP check on `port` unless
you set `probes.readiness`/`.liveness` (see [Config Schema](./config-schema.md#probes)). If your
app takes longer than the default `initialDelaySeconds` (3s readiness / 10s liveness) to start
accepting connections - a slow framework boot, a migration running first - the liveness probe can
kill it before it's actually up. Raise `initialDelaySeconds` for the slow one in
`.local/config.json`, no code change needed.

## `localctl app up` fails with "Missing secret value for: X"

`.local/config.json`'s `secrets` array declares names only - the value has to be set separately,
once, with `localctl app secrets set X` (prompts for it, hidden, if you don't pass it inline). This
is deliberate: it's the same never-plaintext principle addon-generated credentials already follow,
just for values you supply yourself. `localctl app secrets list` shows which declared keys still
need a value; `localctl app secrets show [KEY]` reveals the actual value(s) if you need to check one.

## `localctl doctor` shows `[!!]` for something

Re-run `localctl setup` (or `localctl profiles switch <name>` for a non-default project) — every
step is idempotent and safe to re-run.

## `kubectl` commands fail / wrong cluster

Every `localctl` command that talks to a cluster (`app up/down/status/exec/prune/secrets/logs`,
`doctor`, `hosts`, `addons`) already points `kubectl` at the right project's context itself before
doing anything else (`ensureClusterUp()` - see [Architecture](./architecture.md#multi-project-support)
for exactly which project each command resolves to), so you shouldn't need to do this by hand for
`localctl` itself. This only matters if you're driving `kubectl`/`helm`/`tilt` **directly**,
bypassing `localctl`, and work with other clusters too:

```
kubectl config get-contexts          # k3d-local-dev is "default"; k3d-local-dev-<name> for others
kubectl config use-context k3d-local-dev
```

## Dependency wait-for-it never finishes (pod stuck on `Init:0/1`)

`kubectl get pods` showing `Init:0/1` forever, on an app with a `dependencies` entry, means its
`wait-for-<type>` init container hasn't seen that dependency's Service accept a connection yet (see
[Adding Tools](./adding-tools.md#you-get-a-wait-for-it-init-container-for-free)). Check the
dependency itself first, not the app:

```
kubectl get pods -n <namespace>                       # is the dependency's own pod Running?
kubectl logs <app-pod> -c wait-for-<type>              # what host:port is it retrying?
kubectl describe pod <dependency-pod> -n <namespace>   # why isn't IT coming up (PVC pending, image pull, ...)
```

Fixing the dependency's own pod unblocks the init container automatically on its next retry (every
1s) - there's nothing to restart by hand.

## Browser blocks the site outright, no "proceed anyway" option (HSTS)

This is not a trust-store problem, and clicking around Firefox/Chrome's advanced settings won't
fix it. If the browser says something like *"Someone pretending to be this site could try to
steal..."*, *"you can't add an exception"*, or mentions **HSTS**, the domain suffix itself is the
problem: `.dev` is a real, live, Google-operated top-level domain that's on the browser HSTS
preload list *at the TLD level* — every browser force-HTTPS's **any** `.dev` domain, including
made-up ones, with no click-through, regardless of hosts file entries or a trusted local CA. This
is why the domain here is `local.test` (RFC 2606, reserved for testing, never publicly resolvable,
never HSTS-preloaded) and not `local.dev`. If you're hitting this, you're most likely on an old
checkout from before that change — pull the latest, re-run `localctl setup`, and use
`*.local.test` URLs instead of any old `*.local.dev` ones (and note that `local.dev` itself is a
real domain someone else owns — don't be surprised if an old bookmark for it loads a stranger's
website instead of a local dev error).

## Browser says the certificate isn't trusted (but does let you click through)

This is the normal, expected kind of warning — a trust-store issue, not the HSTS one above.
`mkcert -install` (run by `localctl setup`) adds a local CA to your system/browser trust store. If
it's still untrusted:
- **Firefox keeps its own trust store**, separate from the OS keychain that Safari/Chrome use.
  `mkcert -install` can only add the CA there automatically if `certutil` is installed
  (`brew install nss` on macOS) — without it you'll see exactly this warning in Firefox, in the
  original `localctl setup` output where mkcert says `"certutil" is not available`, and nowhere else.
  Install `nss` and re-run `mkcert -install` (or `localctl setup`), or import the CA into
  Firefox manually (`mkcert -CAROOT` shows where the CA file lives).
- Re-run `localctl setup` to regenerate and reapply the `*.local.test` certificate.

## `<subdomain>.local.test` doesn't resolve

Run `localctl hosts sync`. If it reports a permissions error, it prints the exact `sudo`/elevated
command to run — copy-paste it. Then confirm with `localctl hosts list` and:

```
# macOS/Linux
cat /etc/hosts | grep local.test

# Windows (elevated PowerShell)
Get-Content C:\Windows\System32\drivers\etc\hosts | Select-String local.test
```

## `k3d cluster create` fails with `network not found: bridge` (Podman)

Podman's default network is named `podman`, not `bridge` — Docker is the one with a network
literally named `bridge`. This repo avoids the k3d code path that assumes it exists (the local
registry is run as a plain container by `clusterProvision.js` instead of via k3d's
`registries.create`), so a clean setup should not hit this. If you do:

1. Clean up the partial cluster: `k3d cluster delete <cluster-name>` (`local-dev` for `default`,
   `local-dev-<project>` otherwise), then check for and remove any leftover network/volume named
   `k3d-<cluster-name>*` (`docker network ls` / `podman network ls`, `docker volume ls` /
   `podman volume ls`).
2. Re-run `localctl setup` (`default`) or `localctl profiles switch <name>` (any other project), or
   `./bin/bootstrap.sh` if the CLI isn't installed yet.
3. If it still fails, confirm you're on a current version of `cli/src/lib/clusterProvision.js` —
   this is exactly the bug the plain-container registry approach was built to avoid; a version that
   passed a `registries.create` block to k3d would reintroduce it.

## Port 80 or 443 already in use

Something else on your machine is bound to those ports (another local cluster, a system web
server, IIS on Windows, etc). For the `default` project, either stop whatever's holding the port,
or change `DEFAULT_HTTP_PORT`/`DEFAULT_HTTPS_PORT` in `cli/src/lib/constants.js` (note every app's
`https://<subdomain>.local.test` assumes the default 80/443 mapping, so a custom port means adding
`:<port>` to every URL). For any other Main project, this is exactly what `exclusive: false`
handles for you automatically at creation time (`localctl profiles new`) — its own `httpPort`/
`httpsPort` live in that project's entry in `~/.localctl/profiles.json`, editable directly if you
need to change them after the fact (re-run `localctl profiles switch <name>` after editing to
apply).

## Registry container fails to start: `address already in use` on port 5000

On macOS this is almost always Control Center's AirPlay Receiver, which listens on port 5000 by
default (`lsof -nP -iTCP:5000 -sTCP:LISTEN` will show a process named `ControlCe...`). That's
exactly why the `default` project's registry host-side port is 5050, not 5000
(`REGISTRY_HOST_PORT` in `cli/src/lib/constants.js`) — the container's own port, and the in-cluster
DNS name/port containerd pulls from, stay 5000 either way. If something else is still squatting on
5050 too, change `REGISTRY_HOST_PORT` there (or, for a non-default project, its `registryPort` in
`~/.localctl/profiles.json`) — you don't need to touch any Tiltfile yourself, `localctl app
registry-info` (which every Tiltfile calls) picks up the new port automatically.

## Tilt builds but the pod shows `ImagePullBackOff`

Usually means the image never reached the project's local registry, or the cluster can't resolve
it. Check:
- `localctl app registry-info` (from the app's own repo) prints what Tilt is actually using -
  confirm `pushHost`'s port matches a registry container that's actually running, and
  `clusterHost`'s name matches what's actually on the cluster's network (next two checks).
- The registry container is running: `docker ps` / `podman ps` should show `local-dev-registry`
  (`default`) or `local-dev-<project>-registry` (any other Main project). If it's missing (e.g.
  after a manual container prune), re-run `localctl setup`/`localctl profiles switch <name>` — it's
  idempotent and will recreate just the registry.
- It's on the cluster's network: `docker network inspect k3d-local-dev` (or `k3d-local-dev-<project>`)
  should list the registry container among connected containers. If you created it manually, make
  sure `--network k3d-<cluster-name>` was passed.

## Podman: build fails with `unable to upgrade to h2c, received 404`

Tilt's `docker_build` defaults to BuildKit's gRPC-based build protocol, which Podman's
Docker-API-compat socket doesn't implement. `localctl app up` sets `DOCKER_BUILDKIT=0` automatically
whenever it detects Podman as the active engine (see `cli/src/lib/engine.js` and
`cli/src/commands/up.js`) — you shouldn't need to do anything. If you're driving `tilt` directly
(bypassing `localctl app up`, e.g. `tilt ci`), set it yourself: `DOCKER_BUILDKIT=0 tilt up`.

## Podman: push fails with `server gave HTTP response to HTTPS client`

The local registry is deliberately plain HTTP (no TLS — it's local-only, reachable only from your
machine and the cluster). Podman's client defaults to HTTPS and refuses to talk to it until it's
told the registry is insecure — and because Podman's daemon runs inside a VM, that has to be
configured *inside* that VM, not on the host. `localctl setup`/`localctl profiles new`/`switch` all
do this via `podman machine ssh` before their cluster is even created (`cli/src/lib/podman.js`,
writing `/etc/containers/registries.conf.d/999-local-dev.conf` inside the VM). Each project's
registry port gets its own `[[registry]]` block **appended** to that one file, not overwritten - a
second Main project on a different port doesn't undo the first one's trust entry. `localctl
uninstall` removes the whole file (every project is being torn down anyway at that point). If you
still hit this:
- Confirm the port's block exists: `podman machine ssh <machine-name> "cat
  /etc/containers/registries.conf.d/999-local-dev.conf"` (get `<machine-name>` from `podman
  machine list`). It should list `localhost:<port>` and `127.0.0.1:<port>` as `insecure = true` for
  every project's registry port you've ever provisioned on this machine - `5050` for `default`
  unless you changed `REGISTRY_HOST_PORT` in `cli/src/lib/constants.js`, or whatever `registryPort`
  a non-default project has in `~/.localctl/profiles.json`.
- If a port's block is missing, re-run `localctl setup` (`default`) or `localctl profiles switch
  <name>` (any other project) — idempotent, only restarts the VM if it actually needed to add
  something.

## Forcing an immediate rebuild/redeploy

Tilt tracks `.local/config.json` as a Tiltfile input (via `read_json`) and auto-reloads on changes
to it, same as any other watched file — you don't need to do anything, this is verified working.
If you still want to force a rebuild/redeploy right now, without waiting on any file change (e.g.
to bounce a hung process, or just to be sure):

```
localctl app reload            # from inside the app's repo
localctl app reload -a <name>  # from anywhere
```

This only works for a detached (background) dev loop, i.e. plain `localctl app up` — not
`-f`/`--foreground` mode, which has no separate process for `reload` to address. In foreground
mode Ctrl+C and re-run `localctl app up -f` for a clean restart, or check Tilt's own terminal UI for
its current manual-trigger shortcut.

## `localctl app status` shows a dev loop "running" that clearly isn't

`localctl app up` tracks its background Tilt process by PID in `~/.localctl/run/<app>.pid`. After a
machine reboot (or if the process was killed outside `localctl`), that PID can end up reused by an
unrelated process, which `localctl app status` has no way to distinguish from the real thing. Fix:
`localctl app down` (clears the stale PID file regardless of what's actually running under that PID),
then `localctl app up` again.

## `localctl app up` fails: Tilt exits immediately with `address already in use`

`localctl app up` gives each app's Tilt instance its own random web UI port, precisely to avoid this -
but if you ran `tilt` directly (bypassing `localctl app up`) or a previous `localctl app up -f`
(`--foreground`) session didn't get cleanly killed (e.g. the terminal was force-closed rather than
Ctrl+C'd), you can end up with an orphaned `tilt up` process still holding a port. Because that
process isn't tracked in `~/.localctl/run/` (only detached-mode processes are), `localctl app status`
won't show it and `localctl app down` won't stop it. Find and kill it by hand:

```
ps aux | grep "tilt up"
kill <pid>
```

Then re-run `localctl app up`. As of this fix, a leftover process like this can no longer block a
*different* app's deploy (each gets its own port) - but it's still a stray process worth cleaning
up, and it'll keep blocking `localctl app up -f` for whichever app it belongs to.

## Starting fresh

For a quick cluster-only reset of the `default` project (keeps your CLI install, certs, hosts
entries) - for any other project, substitute its own cluster name (`local-dev-<name>`) and re-run
`localctl profiles switch <name>` instead of `setup`:

```
k3d cluster delete local-dev
localctl setup
```

For a full teardown (every project's cluster, registries, hosts entries, certs/state, everything
`localctl setup`/`localctl profiles` set up), see [Uninstalling](./uninstalling.md) —
`localctl uninstall`, or `./bin/uninstall.sh` / `uninstall.ps1` to also remove the CLI shim — then
run setup again to start clean.

Either way, app data (per-app `PersistentVolumeClaim`s for postgres/mongo) is destroyed with the
cluster — this is a local dev environment, not somewhere to keep data you care about.

## `No cluster running for project "<name>"`

Every app-scoped command (`app up`/`down`/`status`/`reload`) and every cluster-wide one
(`addons ...`, `doctor`, `hosts ...`) checks that the project's cluster actually exists before
doing anything else, rather than failing with a confusing raw `kubectl`/Tilt error further down.
Which project a command means is directory-resolved (see [Architecture — Multi-project
support](./architecture.md#multi-project-support)):

- `Run "localctl setup" to start it.` — you're targeting the `default` project and never
  bootstrapped it (or `k3d cluster delete local-dev`'d it away). This does not auto-run for you,
  even as a side effect of an unrelated command - bringing up a cluster is slow and can prompt for
  `sudo`, both surprising if you didn't ask for it.
- `Run "localctl profiles switch <name>" to start it.` — a Main (own-cluster) or namespace-scoped
  project you created with `localctl profiles new` isn't up. `switch` brings up whichever Main
  project owns it (tearing down other Main projects first if this one is `exclusive` - see
  `localctl profiles status`).
