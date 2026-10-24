# `.local/config.yaml` Reference

Validated against `schema/app.schema.json` (also usable directly for editor autocomplete — add a
`# yaml-language-server: $schema=...` comment as the first line, as `localctl app new` does). Validation is enforced by the CLI (`zod`, in
`cli/src/lib/configSchema.js`) every time you run `localctl app up` or `generate-manifests`.

This is separate from `.local/project.json` (written by `localctl profiles new`, not `app new`) -
that one's just `{"profile": "<name>"}`, marking which project everything under its directory (or
any subfolder below it) belongs to. See [Architecture — Multi-project
support](./architecture.md#multi-project-support).

The file is YAML, so you can comment it. `.local/config.json` from earlier versions is no longer
read: localctl stops with a message if it finds one. JSON is valid YAML, so renaming the file to
`config.yaml` is enough to get going.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string (lowercase letters, digits, dashes; must start and end with a letter or digit) | *required* | Deployment/Service/image name. |
| `subdomain` | string (lowercase letters, digits, dashes; must start and end with a letter or digit) | `name` | App is reachable at `<subdomain>.local.test` — or `<project>-<subdomain>.local.test` if this app belongs to a namespace-scoped project (see below). |
| `namespace` | string (same rules as `name`, at most 63 characters) | `name` | Kubernetes namespace the app is deployed into — or `<project>-<namespace>` under a namespace-scoped project. `default`, anything starting with `kube-`, and `observability`, `cert-manager`, `traefik`, `ingress-nginx` and `localctl` are refused, and so is an existing namespace that `localctl` did not create or that another app owns (see [What a config can't do](#what-a-config-cant-do)). |
| `port` | integer (1-65535) | *required* | Port the app listens on inside the container. |
| `build.context` | string | `.` | Docker build context, relative to the app folder. Absolute paths and `~` are refused, and `..` may climb only as far as the git repository root (monorepos), never out of it, also through symlinks. |
| `build.dockerfile` | string | `Dockerfile` | Dockerfile path, relative to `build.context`. Same rules as `context`. |
| `build.target` | string | — | Multi-stage build target (`docker build --target`): a stage name, never starting with `-`. |
| `build.args` | object | `{}` | Build arguments (`--build-arg KEY=value`). Values are converted to strings. |
| `build.ignore` | array of string | `[]` | Paths left out of the build context and not watched by Tilt (like `.dockerignore`). |
| `command` | array of string | — | Overrides the image `ENTRYPOINT` for the main container. Items like `true` or `3600` are read as text, so `command: [sleep, 3600]` works. |
| `args` | array of string | — | Overrides the image `CMD` for the main container. |
| `envFile` | string | — | A dotenv-style file (`KEY=value` per line, `#` comments) inside the app folder, merged into `env`. Keys written in `env` win. Paths outside the app folder, including through symlinks, are refused. Not for secrets: use `secrets`. |
| `env` | object of string→string | `{}` | Environment variables injected into the container. YAML numbers and booleans (`PORT: 3000`, `DEBUG: true`) are converted to strings and an empty value (`KEY:`) becomes an empty string. Values keep their exact text: `1.10`, `1e3`, `0x10`, `0777`, `+1` and dates are read as text, not converted to numbers. Names are valid variable names (letters, digits, `_`, `.` and `-`, not starting with a digit). |
| `secrets` | array of string (`^[A-Z][A-Z0-9_]*$`) | `[]` | Names of your own secret env vars (API keys, tokens) - values set separately, never here. See [Secrets](#secrets) below. |
| `replicas` | integer | `1` | Deployment replica count. |
| `resources.requests.cpu` / `.memory` | string or number | — | cpu as `250m`, `1` or `0.5` (up to 1024 cores); memory as `256Mi`, `2Gi` or `1G` (up to 1 TiB, no `m` suffix). Zero is refused, and a request can't be larger than its limit. |
| `resources.limits.cpu` / `.memory` | string | — | e.g. `"1"`, `"512Mi"`. |
| `debug.enabled` | boolean | `false` | Whether to expose a debug port. |
| `debug.port` | integer | — | Debug port to expose and port-forward. |
| `debug.type` | `node` \| `python` \| `go` \| `java` \| `dotnet` | — | Used only for documentation/tooling hints; see [Debugging](./debugging.md). |
| `probes.readiness` / `.liveness` | `{ path?, command?, initialDelaySeconds?, periodSeconds?, timeoutSeconds?, failureThreshold? }` | TCP check on `port` | See [Probes](#probes) below. |
| `dependencies` | array of `{ type, version?, database?, storage?, resources? }` | `[]` | Per-app data stores. `database` is letters, digits and underscores, `storage` a size like `2Gi`, `version` a chart version; numbers such as `version: 16.1` are accepted. `resources` (`requests`/`limits` with `cpu` and `memory`) caps the dependency's pod, e.g. `{ limits: { memory: 256Mi } }`; it works for addons that declare `resourcesPath` (the built-in `postgres`, `redis` and `mongo` do). `type` is one of `postgres`, `redis`, `mongo` (or anything you've added — see [Adding Tools](./adding-tools.md)). |
| `sidecars` | array of `{ name, image, port?, command?, args?, env? }` | `[]` | Extra containers in the same pod as your app (the k8s sidecar pattern). |
| `sync` | array of `{ localPath, remotePath }` | `[]` | Paths Tilt live-syncs into the running container without a full rebuild. `localPath` must be relative to the app folder. |
| `run` | array of `{ command, trigger? }` | `[]` | Shell commands run inside the container after files are synced. With `trigger`, only when one of those paths changed (for example `npm install` when `package.json` changes). Needs at least one `sync` entry. |
| `ports` | array of `{ port, name?, protocol?, forward? }` | `[]` | Extra container ports, added to the in-cluster Service too. `protocol` is `TCP` (default) or `UDP`; `forward: true` also forwards a TCP port to `localhost`. A port number can be used once per protocol (TCP and UDP can share one; an unnamed UDP port is called `p<number>-udp`), names are up to 15 characters without `--`, and sidecars can't reuse an app port. |
| `ingress.hosts` | array of subdomains | `[]` | More names under `local.test` routed to the same app (registered in the hosts file like the main one). `app up` refuses a host that another namespace already serves through an Ingress (wildcards included) or a Traefik `IngressRoute` (`Host`, in any case and quoting; a `HostRegexp` that may cover it counts too). |
| `ingress.paths` | array of `{ path, port? }` | `/` | Replaces the default `/` route. `port` must be `port` or a TCP entry of `ports`. |
| `ingress.annotations` | object | `{}` | Only these Traefik annotations: `service.passhostheader`, `service.sticky.cookie`, `service.sticky.cookie.name`, `service.sticky.cookie.secure`, `service.serversscheme` (all under `traefik.ingress.kubernetes.io/`, with strict values: `true`/`false`, a cookie name of letters, digits and `._-`, or `http`/`https`/`h2c`). Route priority, middlewares and TLS options are refused because they can reach into other apps' routes. `router.entrypoints` is always set from `tls`. |
| `volumes` | array of `{ name, mountPath, sizeLimit? }` | `[]` | Scratch space (`emptyDir`) mounted into the app, its sidecars and its init containers; it disappears with the pod. There is deliberately no `hostPath`. `mountPath` is an absolute path in plain form (no `//`, `..` or trailing `/`) and not `/run` or `/var/run`, and not under `/proc`, `/sys`, `/dev` (except `/dev/shm`), `/run/secrets` or `/var/run/secrets` (compared ignoring case). |
| `initContainers` | array of `{ name, image?, command?, args?, env? }` | `[]` | Run to completion before the app starts, in the app's own image unless `image` is set: the place for migrations. See [Migrations](#migrations-and-init-containers). |
| `probes.startup` | probe | — | Gives slow starters time before liveness checks begin. Absent unless set. |
| `labels` | object | `{}` | Extra labels on the Deployment and pods. `app` and `localctl.dev/*` are reserved. |
| `annotations` | object | `{}` | Extra pod annotations. Only a plain key without a domain (`note`, `team`) or keys under `prometheus.io/`, `reloader.stakater.com/`, `fluentbit.io/`, `ad.datadoghq.com/`, `co.elastic.logs/`, `logging.banzaicloud.io/`, `backup.velero.io/` or `checksum/`. Everything else is refused because runtimes, CNIs, meshes and cloud identity read pod annotations and could change how the pod is isolated. `labels` refuse the same families (plus `istio-injection`, `istio.io/*`, `cilium.io/*` and `pod-security.kubernetes.io/*`), but the standard `app.kubernetes.io/*` labels are fine. |
| `imagePullPolicy` | `Always` \| `IfNotPresent` \| `Never` | cluster default | Pull policy of the main container. |
| `terminationGracePeriodSeconds` | integer (0-3600) | cluster default | Time the app gets to shut down on `SIGTERM`. |
| `securityContext` | `{ runAsUser?, runAsGroup?, runAsNonRoot?, readOnlyRootFilesystem?, allowPrivilegeEscalation? }` | — | Settings that tighten the main container only. `privileged` and capabilities are not accepted, `allowPrivilegeEscalation` can only be `false`, and `runAsNonRoot: true` with `runAsUser: 0` is rejected. |
| `environments` | object of named overrides | — | See [Environments](#environments). |
| `tls` | boolean | `true` | Whether the ingress uses HTTPS (cluster's default `*.local.test` cert) or plain HTTP. |

## Example

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/psilvmoreira/localctl/master/schema/app.schema.json
name: orders-api
subdomain: orders
port: 3000
build:
  context: .
  dockerfile: Dockerfile
env:
  NODE_ENV: development
  LOG_LEVEL: debug
replicas: 1
resources:
  requests:
    cpu: 100m
    memory: 128Mi
debug:
  enabled: true
  port: 9229
  type: node
dependencies:
  - type: postgres
    database: orders
    storage: 2Gi
  - type: redis
sync:
  - localPath: ./src
    remotePath: /app/src
tls: true
```

Resolves to `https://orders.local.test`, with a dedicated `orders-postgres` and `orders-redis`
deployed alongside it in the `orders-api` namespace.

## Migrations and init containers

`initContainers` run, in order, before the app container starts. They use the app's own image unless
you set `image`, so a migration sees the code you just built:

```yaml
initContainers:
  - name: migrate
    command: ["npm", "run", "migrate"]
    env:
      MIGRATION_MODE: up
```

They get the volumes declared in `volumes`, but not the app's `env`, `envFile` or secrets: set what
they need under their own `env`. Names can't clash with the app, sidecars or the automatic
`wait-for-*` containers.

## Environments

`environments` holds named partial configs. Pick one with `localctl app up --env <name>`; its
settings are merged over the rest of the file (objects merge key by key, lists and scalars are
replaced):

```yaml
name: orders-api
port: 3000
build: { context: . }
env: { LOG_LEVEL: debug }
replicas: 1
environments:
  load-test:
    replicas: 3
    env: { LOG_LEVEL: warn }
    resources:
      limits: { memory: 512Mi }
```

`name`, `namespace`, `envFile` and `environments` can't be overridden, because other commands
(`down`, `secrets`, `status`) find the app without knowing which environment is running.
`localctl app validate` checks the base config, every environment and the `envFile`. Environment names follow the same rules as app names, and a reserved key such as `__proto__` is an error. Without `--env`, the block is
ignored.

## What a config can't do

A `.local/config.yaml` can come from a repository you cloned, so the schema keeps it to what an app
legitimately needs:

- **No cluster privileges:** no `privileged`, added capabilities, `hostPath`, host networking or
  runtime annotations (AppArmor, seccomp, CRI-O, CNI).
- **No other apps' namespaces:** `app up`, `app down` and `app secrets` refuse a namespace that
  exists but wasn't created by `localctl`, or that belongs to a different app. Use one namespace per
  app. For a namespace made by hand, label it yourself: `kubectl label namespace <name> localctl.dev/managed=true`.
- **No host files:** `build.context`, `build.dockerfile` and `sync[].localPath` must stay inside the
  git repository (relative paths only; `..` stops at the repository root, and symlinks are followed before checking, including `link/..` and paths that don't exist yet; a repository in your home directory doesn't count as a root).
  `envFile` is stricter: it must be a plain file inside the app folder, with no symlinks or hard
  links leading elsewhere, at most 256 KB. `.local/config.yaml` must be a plain file in a real
  `.local` folder (no symlinks or hard links), and `app validate` makes the same path checks as
  `app up`.
- **No injection into tools:** names are Kubernetes labels that can't start with `-`, and
  dependency `version`, `database` and `storage` are checked before they reach Helm.
- **Bounded size:** the file must be under 512 KB and can't expand into a huge tree through YAML
  aliases: at most 200 aliases, no complex `? ` keys (a line of text inside a string that starts
  with `? ` trips this check, so reword it), and long keys and strings count by length.
  Text files (`config.yaml`, `envFile`) must be valid UTF-8, and control characters (including NUL)
  are refused in paths, image names and values. Lists are capped (for example 20 `ports`, 20 `ingress.hosts`, 10 `dependencies`, 10
  `sidecars`), `replicas` at 20, and variable names must be valid (`[A-Za-z_][A-Za-z0-9_]*`).
- **Checks before anything is deleted or overwritten:** `app up`, `down`, `prune`, `secrets` and
  the manifest generation Tilt runs all stop if the cluster can't confirm the namespace is yours
  (API unreachable counts as "can't confirm").
- **Secrets stay secret:** values are stored base64 in the Secret and never in an annotation, and
  `secrets unset` really removes the key. A value can be at most 512 KB, and two `secrets set`
  running at once don't overwrite each other (the update is retried on conflict). `localctl` only
  edits a Secret it created (it carries the `localctl.dev/managed` label); an existing Secret
  named `<app>-secrets` that it didn't create is refused, never merged into.

Some things are deliberately left to you because they are the same trust you give a `Dockerfile` or
`Tiltfile` from that repository: the `image` of sidecars and init containers, `run` commands inside
the container, and what the Dockerfile itself does. `ports` with `forward: true` take a port on your
`localhost`, so check them in a repository you don't know.

## Dependency defaults

Each `type` deploys the real, published Helm chart for that database (Bitnami's PostgreSQL, Redis,
and MongoDB charts — not a hand-rolled container) and auto-injects connection details into the
app's own container as environment variables. Full mechanism: [Adding
Tools](./adding-tools.md#addonyaml-reference).

| `type` | Chart | Env vars injected | Auth |
|---|---|---|---|
| `postgres` | `bitnami/postgresql` | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Random password, generated once, stored as a k8s Secret, injected via `secretKeyRef` — never a plaintext value. |
| `redis` | `bitnami/redis` | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Same as postgres. |
| `mongo` | `bitnami/mongodb` | `MONGO_HOST`, `MONGO_PORT` | Disabled (local dev only) — see `cli/src/lib/addons/mongo/addon.yaml` to turn it on. |

`storage` (default `1Gi`) sizes each chart's own PersistentVolumeClaim, so data survives
`localctl app down` — `localctl app prune` (once the app is down) deletes it along with everything
else left in the app's namespace, if you're actually done with it.
`version` pins the *chart* version (not just the app version inside it) if you need something other
than each addon's own default — see that addon's `addon.yaml`.

Each dependency also gets a `wait-for-<type>` init container automatically, so the app's own
container never starts racing a dependency that isn't accepting connections yet — no config needed,
it targets whatever Service address the chart actually rendered (see
[Architecture](./architecture.md#per-app-vs-cluster-wide-and-how-addons-actually-work) for why
that's read back from the real output rather than assumed).

## Secrets

For values *you* supply (a third-party API key, a Stripe token) rather than ones an addon
generates for you - `.local/config.yaml` only ever holds the *name*:

```yaml
secrets:
  - STRIPE_KEY
```

Then, separately:

```
localctl app secrets set STRIPE_KEY        # prompts, hidden input, if no value is given inline
localctl app secrets list                  # which keys are set (not their values)
localctl app secrets show [KEY]            # reveal the actual value(s) - use with care
localctl app secrets unset STRIPE_KEY
```

The value is stored once as a real k8s Secret (`<name>-secrets`) and injected via `secretKeyRef` -
never written to `.local/config.yaml`, never plaintext anywhere in this pipeline, same principle
addon-generated credentials already follow. A key can't appear in both `env` and `secrets` (config
validation rejects it - pick one). `localctl app up` refuses to deploy if a declared key has no
value set yet, and tells you the exact command to fix it.

## Probes

```yaml
probes:
  readiness:
    path: /health
    initialDelaySeconds: 5
  liveness:
    periodSeconds: 30
```

Left out entirely (the default), both readiness and liveness are a plain TCP check on `port` - so
`kubectl rollout status` succeeding means the app is actually accepting connections, not just that
its process started. Set `path` on either to switch that one to an HTTP GET check instead.
Applies to the main app container only, not sidecars.

## Sidecars

An extra container in the *same pod* as your app — the classic k8s sidecar pattern (a background
job runner next to a web app, a log/metrics shipper, anything that needs to share the pod's
network namespace or filesystem with your app rather than talk to it over a Service). No Service
is needed for your app to reach it: same pod means `localhost:<port>` already works.

```yaml
sidecars:
  - name: job-runner
    image: my-registry/job-runner:latest
    port: 8080
    args:
      - "--queue=default"
    env:
      LOG_LEVEL: debug
```

This is different from a per-app `dependencies` entry: a dependency is its own separate pod (its
own lifecycle, its own scaling), reached over the network by DNS name; a sidecar lives and dies
with your app's own pod, reached via `localhost`. Use a sidecar when the two processes are tightly
coupled and always deployed together; use a dependency when they're genuinely separate services.
