const yaml = require('js-yaml');
const { DOMAIN } = require('./constants');
const { loadAddon } = require('./addonLoader');
const { findAddonDir, listAddonNames } = require('./addonDirs');
const { secretNameFor } = require('./appSecrets');

function buildNamespace(cfg) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: cfg.namespace,
      labels: { 'localctl.dev/managed': 'true' },
      annotations: { 'localctl.dev/app': cfg.name },
    },
  };
}

// A sidecar - an extra container sharing the pod's network namespace with the main app container.
// No Service needed for the app to reach it: same pod means `localhost:<port>` already works.
function buildSidecarContainer(sidecar, volumeMounts = []) {
  const container = { name: sidecar.name, image: sidecar.image };
  if (sidecar.command) container.command = sidecar.command;
  if (sidecar.args) container.args = sidecar.args;
  // No port name: names are limited to 15 characters and must be unique across the pod.
  if (sidecar.port) container.ports = [{ containerPort: sidecar.port }];
  const envVars = Object.entries(sidecar.env || {}).map(([name, value]) => ({ name, value: String(value) }));
  if (envVars.length) container.env = envVars;
  if (volumeMounts.length) container.volumeMounts = volumeMounts;
  return container;
}

// Defaults to a plain TCP check on the app's own port when nothing more specific is configured -
// zero-config, but still real: `kubectl rollout status` succeeding used to only mean "the process
// started," not "it's actually accepting connections." An explicit `path` upgrades it to an HTTP
// check instead.
function buildProbe(probeCfg, port, defaults) {
  let check = { tcpSocket: { port } };
  if (probeCfg && probeCfg.path) check = { httpGet: { path: probeCfg.path, port } };
  if (probeCfg && probeCfg.command) check = { exec: { command: probeCfg.command } };
  const probe = {
    ...check,
    initialDelaySeconds: (probeCfg && probeCfg.initialDelaySeconds) ?? defaults.initialDelaySeconds,
    periodSeconds: (probeCfg && probeCfg.periodSeconds) ?? defaults.periodSeconds,
  };
  if (probeCfg && probeCfg.timeoutSeconds) probe.timeoutSeconds = probeCfg.timeoutSeconds;
  if (probeCfg && probeCfg.failureThreshold) probe.failureThreshold = probeCfg.failureThreshold;
  return probe;
}

// Blocks the main container from starting until a dependency's real Service is actually accepting
// connections - without this, a dependency that isn't ready yet when the app's own container
// starts is a race the app has to handle itself (or crash-loop until it wins it).
function buildWaitInitContainer(depType, connect) {
  return {
    name: `wait-for-${depType}`,
    image: 'busybox:1.36',
    // host and port are passed as arguments ($0, $1, $2), never spliced into the script text.
    command: ['sh', '-c', 'until nc -z -w1 "$0" "$1"; do echo "waiting for $2 ($0:$1)..."; sleep 1; done', String(connect.host), String(connect.port), depType],
  };
}

// An init container the developer declared (migrations, seeding). Runs in the app's own image
// unless another is given; Tilt swaps the app image for the freshly built one like it does for the
// main container.
function buildUserInitContainer(cfg, init, volumeMounts) {
  const container = { name: init.name, image: init.image || cfg.name };
  if (init.command) container.command = init.command;
  if (init.args) container.args = init.args;
  const envVars = Object.entries(init.env || {}).map(([name, value]) => ({ name, value: String(value) }));
  if (envVars.length) container.env = envVars;
  if (volumeMounts.length) container.volumeMounts = volumeMounts;
  return container;
}

function buildDeployment(cfg, envVars, initContainers) {
  const ports = [{ name: 'http', containerPort: cfg.port }];
  if (cfg.debug.enabled && cfg.debug.port) ports.push({ name: 'debug', containerPort: cfg.debug.port });
  for (const extra of cfg.ports) {
    ports.push({ name: portName(extra), containerPort: extra.port, protocol: extra.protocol });
  }

  const volumeMounts = cfg.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath }));
  const allInitContainers = [
    ...cfg.initContainers.map((init) => buildUserInitContainer(cfg, init, volumeMounts)),
    ...initContainers,
  ];
  const labels = { ...cfg.labels, app: cfg.name };
  const probes = {};
  probes.readinessProbe = buildProbe(cfg.probes.readiness, cfg.port, { initialDelaySeconds: 3, periodSeconds: 10 });
  probes.livenessProbe = buildProbe(cfg.probes.liveness, cfg.port, { initialDelaySeconds: 10, periodSeconds: 20 });
  if (cfg.probes.startup) probes.startupProbe = buildProbe(cfg.probes.startup, cfg.port, { initialDelaySeconds: 0, periodSeconds: 5 });

  const podAnnotations = Object.keys(cfg.annotations).length
    ? Object.fromEntries(Object.entries(cfg.annotations).map(([k, v]) => [k, String(v)]))
    : undefined;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: cfg.name,
      namespace: cfg.namespace,
      labels: { ...labels, 'localctl.dev/managed': 'true' },
    },
    spec: {
      replicas: cfg.replicas,
      selector: { matchLabels: { app: cfg.name } },
      template: {
        metadata: { labels, annotations: podAnnotations },
        spec: {
          terminationGracePeriodSeconds: cfg.terminationGracePeriodSeconds,
          initContainers: allInitContainers.length ? allInitContainers : undefined,
          volumes: cfg.volumes.length
            ? cfg.volumes.map((v) => ({
                name: v.name,
                emptyDir: v.sizeLimit ? { sizeLimit: v.sizeLimit } : {},
              }))
            : undefined,
          containers: [
            {
              name: cfg.name,
              // Rewritten to the local registry by Tilt's default_registry()/docker_build().
              image: cfg.name,
              imagePullPolicy: cfg.imagePullPolicy,
              command: cfg.command,
              args: cfg.args,
              ports,
              env: envVars,
              volumeMounts: volumeMounts.length ? volumeMounts : undefined,
              securityContext: cfg.securityContext,
              ...probes,
              resources: cfg.resources
                ? { requests: cfg.resources.requests, limits: cfg.resources.limits }
                : undefined,
            },
            ...cfg.sidecars.map((s) => buildSidecarContainer(s, volumeMounts)),
          ],
        },
      },
    },
  };
}

// Port names are limited to 15 characters; unnamed ports get "p<number>".
function portName(extra) {
  return extra.name || (extra.protocol === 'UDP' ? `p${extra.port}-udp` : `p${extra.port}`);
}

function buildService(cfg) {
  const ports = [{ name: 'http', port: cfg.port, targetPort: cfg.port }];
  if (cfg.debug.enabled && cfg.debug.port) {
    ports.push({ name: 'debug', port: cfg.debug.port, targetPort: cfg.debug.port });
  }
  for (const extra of cfg.ports) {
    ports.push({ name: portName(extra), port: extra.port, targetPort: extra.port, protocol: extra.protocol });
  }
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: cfg.name,
      namespace: cfg.namespace,
      labels: { app: cfg.name, 'localctl.dev/managed': 'true' },
    },
    spec: { selector: { app: cfg.name }, ports },
  };
}

function buildIngress(cfg) {
  const hosts = (cfg.hosts || [cfg.subdomain]).map((h) => `${h}.${DOMAIN}`);
  const paths = (cfg.ingress.paths.length ? cfg.ingress.paths : [{ path: '/' }]).map((p) => ({
    path: p.path,
    pathType: 'Prefix',
    backend: { service: { name: cfg.name, port: { number: p.port || cfg.port } } },
  }));
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: cfg.name,
      namespace: cfg.namespace,
      labels: { app: cfg.name, 'localctl.dev/managed': 'true' },
      annotations: {
        ...Object.fromEntries(Object.entries(cfg.ingress.annotations).map(([k, v]) => [k, String(v)])),
        // Set last: whether the route is HTTPS follows `tls`, not an annotation.
        'traefik.ingress.kubernetes.io/router.entrypoints': cfg.tls ? 'websecure' : 'web',
      },
    },
    spec: {
      rules: hosts.map((host) => ({ host, http: { paths } })),
    },
  };
  // Empty secretName: Traefik falls back to the cluster's default TLSStore certificate
  // (the *.local.test cert installed by bin/bootstrap.sh / bootstrap.ps1).
  if (cfg.tls) ingress.spec.tls = [{ hosts }];
  return ingress;
}

// Every addon type is a folder named <type>/addon.yaml, found in your own addons dir
// (~/.localctl/addons, or $LOCALCTL_ADDONS_DIR) if present, else the ones bundled with this CLI
// (see docs/adding-tools.md) - there's no hardcoded list to keep in sync, dropping in a new folder
// is enough to make a new dependency type usable, and a name in your own dir overrides a built-in
// one of the same name.
function knownAddonTypes() {
  return listAddonNames();
}

function generateManifests(cfg) {
  const literalEnv = { ...cfg.env };
  const secretEnv = {}; // envVarName -> { secret, key }
  const addonYamls = [];
  const initContainers = [];

  for (const dep of cfg.dependencies) {
    const addonDir = findAddonDir(dep.type);
    if (!addonDir) {
      throw new Error(
        `Unknown dependency type "${dep.type}" (no addon.yaml found for it in ~/.localctl/addons ` +
        `or the CLI's built-in addons). Known types: ${knownAddonTypes().join(', ')}. See ` +
        'docs/adding-tools.md to add a new one.',
      );
    }
    const release = `${cfg.name}-${dep.type}`;
    const { manifestYaml, env, envFromSecret, connect } = loadAddon(addonDir, {
      release,
      namespace: cfg.namespace,
      addonName: dep.type,
      owner: cfg.name,
      chartVersionOverride: dep.version,
      resources: dep.resources,
      extraVars: {
        database: dep.database || cfg.name,
        storage: dep.storage || '1Gi',
      },
    });
    addonYamls.push(manifestYaml);
    Object.assign(literalEnv, env);
    Object.assign(secretEnv, envFromSecret);
    if (connect) initContainers.push(buildWaitInitContainer(dep.type, connect));
  }
  // cfg.env (what the developer explicitly set) always wins over an addon's auto-injected default.
  Object.assign(literalEnv, cfg.env);

  // Your own secrets (API keys, third-party tokens - not addon-generated credentials): declared by
  // name only in config, values set separately via `localctl app secrets set`, injected the same
  // never-plaintext way as an addon's. configSchema.js already rejects a key appearing in both
  // "env" and "secrets", so no collision to resolve here.
  for (const key of cfg.secrets) {
    secretEnv[key] = { secret: secretNameFor(cfg), key };
  }

  // One definition per variable name: a value the developer wrote in `env` beats an addon's
  // secretKeyRef of the same name, and a name declared in `secrets` beats an addon's plain value.
  for (const key of Object.keys(cfg.env)) delete secretEnv[key];
  for (const key of cfg.secrets) delete literalEnv[key];

  const envVars = [
    ...Object.entries(literalEnv).map(([name, value]) => ({ name, value: String(value) })),
    ...Object.entries(secretEnv).map(([name, ref]) => ({
      name,
      valueFrom: { secretKeyRef: { name: ref.secret, key: ref.key } },
    })),
  ];

  const docs = [buildNamespace(cfg), buildDeployment(cfg, envVars, initContainers), buildService(cfg), buildIngress(cfg)];
  const rendered = docs.map((d) => yaml.dump(d, { noRefs: true })).join('---\n');
  // trimEnd() before joining: addon YAML doesn't reliably end with a trailing newline (see
  // addonLoader.js), and joining on a bare '---\n' in that case glues the separator directly onto
  // the previous piece's last line with no line break, corrupting the YAML.
  return [rendered, ...addonYamls].map((doc) => doc.trimEnd()).join('\n---\n');
}

module.exports = { generateManifests, knownAddonTypes, buildWaitInitContainer };
