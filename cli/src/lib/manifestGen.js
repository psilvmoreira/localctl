const yaml = require('js-yaml');
const { DOMAIN } = require('./constants');
const { loadAddon } = require('./addonLoader');
const { findAddonDir, listAddonNames } = require('./addonDirs');
const { secretNameFor } = require('./appSecrets');

function buildNamespace(cfg) {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: cfg.namespace } };
}

// A sidecar - an extra container sharing the pod's network namespace with the main app container.
// No Service needed for the app to reach it: same pod means `localhost:<port>` already works.
function buildSidecarContainer(sidecar) {
  const container = { name: sidecar.name, image: sidecar.image };
  if (sidecar.command) container.command = sidecar.command;
  if (sidecar.args) container.args = sidecar.args;
  if (sidecar.port) container.ports = [{ name: sidecar.name, containerPort: sidecar.port }];
  const envVars = Object.entries(sidecar.env || {}).map(([name, value]) => ({ name, value: String(value) }));
  if (envVars.length) container.env = envVars;
  return container;
}

// Defaults to a plain TCP check on the app's own port when nothing more specific is configured -
// zero-config, but still real: `kubectl rollout status` succeeding used to only mean "the process
// started," not "it's actually accepting connections." An explicit `path` upgrades it to an HTTP
// check instead.
function buildProbe(probeCfg, port, defaults) {
  const check = probeCfg && probeCfg.path
    ? { httpGet: { path: probeCfg.path, port } }
    : { tcpSocket: { port } };
  return {
    ...check,
    initialDelaySeconds: (probeCfg && probeCfg.initialDelaySeconds) ?? defaults.initialDelaySeconds,
    periodSeconds: (probeCfg && probeCfg.periodSeconds) ?? defaults.periodSeconds,
  };
}

// Blocks the main container from starting until a dependency's real Service is actually accepting
// connections - without this, a dependency that isn't ready yet when the app's own container
// starts is a race the app has to handle itself (or crash-loop until it wins it).
function buildWaitInitContainer(depType, connect) {
  return {
    name: `wait-for-${depType}`,
    image: 'busybox:1.36',
    command: ['sh', '-c', `until nc -z -w1 ${connect.host} ${connect.port}; do echo "waiting for ${depType} (${connect.host}:${connect.port})..."; sleep 1; done`],
  };
}

function buildDeployment(cfg, envVars, initContainers) {
  const ports = [{ name: 'http', containerPort: cfg.port }];
  if (cfg.debug.enabled && cfg.debug.port) ports.push({ name: 'debug', containerPort: cfg.debug.port });

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: cfg.name,
      namespace: cfg.namespace,
      labels: { app: cfg.name, 'localctl.dev/managed': 'true' },
    },
    spec: {
      replicas: cfg.replicas,
      selector: { matchLabels: { app: cfg.name } },
      template: {
        metadata: { labels: { app: cfg.name } },
        spec: {
          initContainers: initContainers.length ? initContainers : undefined,
          containers: [
            {
              name: cfg.name,
              // Rewritten to the local registry by Tilt's default_registry()/docker_build().
              image: cfg.name,
              ports,
              env: envVars,
              readinessProbe: buildProbe(cfg.probes.readiness, cfg.port, { initialDelaySeconds: 3, periodSeconds: 10 }),
              livenessProbe: buildProbe(cfg.probes.liveness, cfg.port, { initialDelaySeconds: 10, periodSeconds: 20 }),
              resources: cfg.resources
                ? { requests: cfg.resources.requests, limits: cfg.resources.limits }
                : undefined,
            },
            ...cfg.sidecars.map(buildSidecarContainer),
          ],
        },
      },
    },
  };
}

function buildService(cfg) {
  const ports = [{ name: 'http', port: cfg.port, targetPort: cfg.port }];
  if (cfg.debug.enabled && cfg.debug.port) {
    ports.push({ name: 'debug', port: cfg.debug.port, targetPort: cfg.debug.port });
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
  const host = `${cfg.subdomain}.${DOMAIN}`;
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: cfg.name,
      namespace: cfg.namespace,
      labels: { app: cfg.name, 'localctl.dev/managed': 'true' },
      annotations: {
        'traefik.ingress.kubernetes.io/router.entrypoints': cfg.tls ? 'websecure' : 'web',
      },
    },
    spec: {
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: cfg.name, port: { number: cfg.port } } },
              },
            ],
          },
        },
      ],
    },
  };
  // Empty secretName: Traefik falls back to the cluster's default TLSStore certificate
  // (the *.local.test cert installed by bin/bootstrap.sh / bootstrap.ps1).
  if (cfg.tls) ingress.spec.tls = [{ hosts: [host] }];
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

  const envVars = [
    ...Object.entries(literalEnv).map(([name, value]) => ({ name, value: String(value) })),
    ...Object.entries(secretEnv).map(([name, ref]) => ({
      name,
      valueFrom: { secretKeyRef: { name: ref.secret, key: ref.key } },
    })),
  ];

  const docs = [buildNamespace(cfg), buildDeployment(cfg, envVars, initContainers), buildService(cfg), buildIngress(cfg)];
  const rendered = docs.map((d) => yaml.dump(d)).join('---\n');
  // trimEnd() before joining: addon YAML doesn't reliably end with a trailing newline (see
  // addonLoader.js), and joining on a bare '---\n' in that case glues the separator directly onto
  // the previous piece's last line with no line break, corrupting the YAML.
  return [rendered, ...addonYamls].map((doc) => doc.trimEnd()).join('\n---\n');
}

module.exports = { generateManifests, knownAddonTypes };
