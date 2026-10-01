# Adding Tools

Every addon — a per-app database or a cluster-wide tool like logging — is **one folder containing
one `addon.yaml`** that points at a real, published Helm chart. There's no JS to write. Dropping
in a new folder is enough; the CLI discovers it automatically.

## Where addons live

Two locations are searched, in this order, and merged — a name in your own directory replaces a
built-in addon of the same name; a new name just adds to the list:

1. **Your own addons** — `~/.localctl/addons/` by default, or wherever `$LOCALCTL_ADDONS_DIR`
   points (e.g. a folder checked into your own team's infra repo, shared across machines). Never
   touched by a `localctl` update or reinstall — this is the one you own.
2. **Built-in addons** — bundled with the CLI itself (`cli/src/lib/addons/`): `postgres`, `redis`,
   `mongo`, and the cluster-wide `logging`/`monitoring` addons. Useful defaults, not meant to be
   your only option.

This split exists so installing this tool doesn't mean inheriting its author's addon set: ignore
the built-ins entirely, override individual ones, or add your own — none of it requires touching
the CLI's own source.

```
~/.localctl/addons/                  your own addons - create this yourself, empty by default
├── kafka/addon.yaml                 example: a new per-app dependency type
└── cluster/
    └── tracing/addon.yaml           example: a new cluster-wide addon

cli/src/lib/addons/                  built-in, bundled with the CLI
├── postgres/addon.yaml              per-app: real Bitnami PostgreSQL chart
├── redis/addon.yaml                 per-app: real Bitnami Redis chart
├── mongo/addon.yaml                 per-app: real Bitnami MongoDB chart
└── cluster/
    ├── logging/
    │   ├── addon.yaml               cluster-wide: Grafana Labs' loki-stack chart
    │   └── config/                  extra literal files the chart doesn't take as a Helm value
    │       └── all-logs.json        a Grafana dashboard, provisioned automatically
    └── monitoring/
        └── addon.yaml               cluster-wide: prometheus-community's Prometheus chart
```

A generic loader (`cli/src/lib/addonLoader.js`) does all the actual work for every addon,
regardless of which location it came from: adds the chart's repo, generates and injects any
secrets, turns a `config/` folder into a ConfigMap, and runs `helm template` to produce the
manifests that get merged into your app's deploy (or applied directly for cluster-wide addons).
You never call Helm yourself.

## `addon.yaml` reference

```yaml
chart:
  repo: https://charts.bitnami.com/bitnami   # any Helm chart repo
  name: postgresql                            # chart name in that repo
  version: "18.12.2"                          # pinned - avoids "latest" surprises

# Generates each key's value once (random), stores it as a real k8s Secret named
# "<release>-secret" - never written to disk, never in this file, never in a Helm value.
secrets:
  password:
    length: 20

# Plain env vars auto-injected into the app's own container.
env:
  POSTGRES_HOST: "{{serviceHost}}"
  POSTGRES_PORT: "5432"
  POSTGRES_DB: "{{database}}"

# Unlike `env`, these become a real k8s secretKeyRef in the app's Deployment - the actual
# password never passes through a plaintext value anywhere in this pipeline.
envFromSecret:
  POSTGRES_PASSWORD:
    secret: "{{secretName}}"
    key: password

# Set to `true` if this addon has a config/ folder (see below).
config: false

# Passed to `helm template -f values.yaml`, after {{...}} substitution.
values: |
  auth:
    database: "{{database}}"
    existingSecret: "{{secretName}}"
  primary:
    persistence:
      size: "{{storage}}"
```

### Template variables

Available inside `values`, `env`, and `envFromSecret`:

| Variable | Where it comes from |
|---|---|
| `{{release}}` | `<appName>-<addonFolderName>` for a per-app addon, or just the addon's folder name for a cluster-wide one |
| `{{namespace}}` | The app's namespace (per-app) or `observability` (cluster-wide) |
| `{{database}}`, `{{storage}}` | The matching fields from the app's `.local/config.json` dependency entry (`dependencies: [{ "type": "postgres", "database": "...", "storage": "..." }]`), with sensible fallback defaults |
| `{{secretName}}` | Only if `secrets:` is set — the generated Secret's real name |
| `{{configMapName}}` | Only if `config: true` and a `config/` folder exists — the generated ConfigMap's real name |
| `{{serviceHost}}` | The actual Service the chart created, **read back out of its own rendered output** — not predicted from a naming convention, since every chart names its Service differently (Bitnami's PostgreSQL chart uses `<release>-postgresql`; its Redis chart uses `<release>-master` with no chart name at all when the release name already contains "redis") |

Cluster-wide addons additionally get `{{domain}}` (the `*.local.test` suffix), since they're not
tied to any one app.

### You get a "wait for it" init container for free

If your addon renders a `Service`, the app that depends on it automatically gets a
`wait-for-<type>` init container blocking its main container from starting until that Service is
actually accepting TCP connections — no field to set, nothing to opt into. This comes from the same
place `{{serviceHost}}` does: `addonLoader.js` reads the real rendered Service's name *and port*
back out of `helm template`'s own output (`findServicePort()`), so it works for any chart's actual
Service, not a naming guess. The only way to lose this is for your addon to render no `Service` at
all (nothing to wait on, and nothing breaks either — the init container is just skipped).

### Secrets

```yaml
secrets:
  password:
    length: 20
```

Each key becomes a Secret key, generated once with a random value of the given length and stored
as a real Kubernetes Secret — the plaintext value only ever exists transiently in the CLI's own
memory and inside that Secret object (base64 at rest in etcd, standard k8s handling). A re-run
that finds the Secret already there leaves it alone, so your database's actual password never
rotates out from under it. Reference it in `values` via `{{secretName}}` (for whatever
`existingSecret`-style field the chart itself expects — check `helm show values <repo>/<chart>`),
and expose it to your app via `envFromSecret`, never `env`.

### The `config/` folder

For addon-specific content that isn't a Helm *value* at all — Grafana dashboards, datasource
definitions, init scripts — drop files in `config/` next to `addon.yaml`, set `config: true`, and
reference `{{configMapName}}` wherever the chart expects a ConfigMap name. See
`cli/src/lib/addons/cluster/logging/addon.yaml` for a complete worked example: it wires a single
dashboard JSON file into Grafana's `dashboardsConfigMaps` (which, per that chart, also needs a
matching `dashboardProviders` entry — check a chart's own `helm show values` output for anything
like this before assuming a single field is enough).

## Adding a per-app dependency (e.g. Kafka, Elasticsearch)

1. Find the chart: `helm search hub <name>`, or go straight to the project's own Helm repo if you
   know it (e.g. Elastic's own `https://helm.elastic.co`).
2. Check its values: `helm repo add tmp <repo-url> && helm show values tmp/<chart>` — look for how
   it takes an existing secret (if it needs a password) and its persistence size field.
3. Create `~/.localctl/addons/kafka/addon.yaml` following the reference above — your own addons
   dir, not the CLI's built-in one (see [Where addons live](#where-addons-live)).
4. Use it in any app's `.local/config.json`:
   ```json
   "dependencies": [{ "type": "kafka", "version": "..." }]
   ```

That's it — no registration step, no JS, no schema file to edit. `localctl app generate-manifests`
(called automatically by the Tiltfile) discovers the new folder on its own.

## Adding a cluster-wide addon (e.g. Jaeger tracing, a shared message broker)

Same shape, different location: `~/.localctl/addons/cluster/<name>/addon.yaml`. Enable/disable
with `localctl addons enable <name>` / `disable <name>`. No `secrets`/`envFromSecret` wiring into
an app container (there's no single app to inject into) — if the addon needs an ingress so you can
reach it from a browser, give it one on `<name>.{{domain}}` (see the logging addon's `grafana.
{{domain}}` for the pattern).

## Guidelines

- **Pin chart versions.** `chart.version` should always be set — floating on "latest" means a
  chart upstream change can silently break your local setup.
- **Keep per-app addons cheap to throw away.** No replication, small default storage sizes. They
  live and die with `localctl app up` / `localctl app down`.
- **Never put a secret in `env` or `values`.** Generate it with `secrets:`, reference the
  generated Secret's name (`{{secretName}}`) in `values`/`envFromSecret`, and let the chart's own
  `existingSecret`-style field pick it up.
- **If a chart's naming or values structure doesn't fit the reference above cleanly** (multi-user
  auth, non-standard secret key layout, etc.), it's fine to write a more elaborate `values` block
  for that one addon — the mechanism doesn't require every addon to look identical, only that each
  one is a single self-contained `addon.yaml`.
