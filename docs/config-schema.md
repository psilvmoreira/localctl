# `.local/config.json` Reference

Validated against `schema/app.schema.json` (also usable directly for editor autocomplete — point
`"$schema"` at it, as `localctl app new` does). Validation is enforced by the CLI (`zod`, in
`cli/src/lib/configSchema.js`) every time you run `localctl app up` or `generate-manifests`.

This is separate from `.local/project.json` (written by `localctl profiles new`, not `app new`) -
that one's just `{"profile": "<name>"}`, marking which project everything under its directory (or
any subfolder below it) belongs to. See [Architecture — Multi-project
support](./architecture.md#multi-project-support).

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string (`^[a-z0-9-]+$`) | *required* | Deployment/Service/image name. |
| `subdomain` | string (`^[a-z0-9-]+$`) | `name` | App is reachable at `<subdomain>.local.test` — or `<project>-<subdomain>.local.test` if this app belongs to a namespace-scoped project (see below). |
| `namespace` | string | `name` | Kubernetes namespace the app is deployed into — or `<project>-<namespace>` under a namespace-scoped project. |
| `port` | integer | *required* | Port the app listens on inside the container. |
| `build.context` | string | `.` | Docker build context, relative to the app repo root. |
| `build.dockerfile` | string | `Dockerfile` | Dockerfile path, relative to `build.context`. |
| `env` | object of string→string | `{}` | Environment variables injected into the container. |
| `secrets` | array of string (`^[A-Z][A-Z0-9_]*$`) | `[]` | Names of your own secret env vars (API keys, tokens) - values set separately, never here. See [Secrets](#secrets) below. |
| `replicas` | integer | `1` | Deployment replica count. |
| `resources.requests.cpu` / `.memory` | string | — | e.g. `"250m"`, `"256Mi"`. |
| `resources.limits.cpu` / `.memory` | string | — | e.g. `"1"`, `"512Mi"`. |
| `debug.enabled` | boolean | `false` | Whether to expose a debug port. |
| `debug.port` | integer | — | Debug port to expose and port-forward. |
| `debug.type` | `node` \| `python` \| `go` \| `java` \| `dotnet` | — | Used only for documentation/tooling hints; see [Debugging](./debugging.md). |
| `probes.readiness` / `.liveness` | `{ path?, initialDelaySeconds?, periodSeconds? }` | TCP check on `port` | See [Probes](#probes) below. |
| `dependencies` | array of `{ type, version?, database?, storage? }` | `[]` | Per-app data stores. `type` is one of `postgres`, `redis`, `mongo` (or anything you've added — see [Adding Tools](./adding-tools.md)). |
| `sidecars` | array of `{ name, image, port?, command?, args?, env? }` | `[]` | Extra containers in the same pod as your app (the k8s sidecar pattern). |
| `sync` | array of `{ localPath, remotePath }` | `[]` | Paths Tilt live-syncs into the running container without a full rebuild. |
| `tls` | boolean | `true` | Whether the ingress uses HTTPS (cluster's default `*.local.test` cert) or plain HTTP. |

## Example

```json
{
  "$schema": "../../Project-Infra/schema/app.schema.json",
  "name": "orders-api",
  "subdomain": "orders",
  "port": 3000,
  "build": { "context": ".", "dockerfile": "Dockerfile" },
  "env": { "NODE_ENV": "development", "LOG_LEVEL": "debug" },
  "replicas": 1,
  "resources": { "requests": { "cpu": "100m", "memory": "128Mi" } },
  "debug": { "enabled": true, "port": 9229, "type": "node" },
  "dependencies": [
    { "type": "postgres", "database": "orders", "storage": "2Gi" },
    { "type": "redis" }
  ],
  "sync": [{ "localPath": "./src", "remotePath": "/app/src" }],
  "tls": true
}
```

Resolves to `https://orders.local.test`, with a dedicated `orders-postgres` and `orders-redis`
deployed alongside it in the `orders-api` namespace.

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
generates for you - `.local/config.json` only ever holds the *name*:

```json
"secrets": ["STRIPE_KEY"]
```

Then, separately:

```
localctl app secrets set STRIPE_KEY        # prompts, hidden input, if no value is given inline
localctl app secrets list                  # which keys are set (not their values)
localctl app secrets show [KEY]            # reveal the actual value(s) - use with care
localctl app secrets unset STRIPE_KEY
```

The value is stored once as a real k8s Secret (`<name>-secrets`) and injected via `secretKeyRef` -
never written to `.local/config.json`, never plaintext anywhere in this pipeline, same principle
addon-generated credentials already follow. A key can't appear in both `env` and `secrets` (config
validation rejects it - pick one). `localctl app up` refuses to deploy if a declared key has no
value set yet, and tells you the exact command to fix it.

## Probes

```json
"probes": {
  "readiness": { "path": "/health", "initialDelaySeconds": 5 },
  "liveness": { "periodSeconds": 30 }
}
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

```json
"sidecars": [
  {
    "name": "job-runner",
    "image": "my-registry/job-runner:latest",
    "port": 8080,
    "args": ["--queue=default"],
    "env": { "LOG_LEVEL": "debug" }
  }
]
```

This is different from a per-app `dependencies` entry: a dependency is its own separate pod (its
own lifecycle, its own scaling), reached over the network by DNS name; a sidecar lives and dies
with your app's own pod, reached via `localhost`. Use a sidecar when the two processes are tightly
coupled and always deployed together; use a dependency when they're genuinely separate services.
