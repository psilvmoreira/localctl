const os = require('os');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { run, capture, sleepSync, commandExists } = require('./exec');
const { detectEngine, warnIfExperimental } = require('./engine');
const { installIfMissing } = require('./toolInstall');
const { ensureInsecureRegistry } = require('./podman');
const { DOMAIN } = require('./constants');
const logger = require('./logger');

// Cluster-level manifests: bundled under cli/assets/ in the npm package (copied there by
// scripts/sync-assets.js at pack time), or read straight from the repo root in a git checkout.
const BUNDLED_MANIFESTS_DIR = path.resolve(__dirname, '..', '..', 'assets', 'manifests');
const MANIFESTS_DIR = fs.existsSync(BUNDLED_MANIFESTS_DIR)
  ? BUNDLED_MANIFESTS_DIR
  : path.resolve(__dirname, '..', '..', '..', 'cluster', 'manifests');

function registryNameFor(clusterName) {
  return `${clusterName}-registry`;
}

function clusterExists(clusterName) {
  return capture('k3d', ['cluster', 'list']).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .includes(clusterName);
}

// Brings up (idempotently) one Main project's cluster: container engine + tool checks, the k3d
// cluster itself (own ports, since two clusters can't both bind host :80/:443), its own local
// registry container, and the shared *.local.test TLS cert wired into its Traefik. Used by both
// `localctl setup` (the "default" profile, unchanged ports/names from before multi-project
// support) and `localctl profiles new`/`switch` (any other Main project).
function provisionCluster({ clusterName, httpPort, httpsPort, registryPort }) {
  logger.step('Detecting container engine...');
  const detected = detectEngine();
  if (!detected) {
    throw new Error('No running container engine found. Start Docker Desktop, Podman, or Rancher Desktop and re-run.');
  }
  const { engine, bin: engineBin } = detected;
  logger.success(`Using container engine: ${engine} (${engineBin} CLI)`);
  warnIfExperimental(engine);

  // Podman-specific, and must happen before the cluster/registry exist - see lib/podman.js. The
  // insecure-registry trust is VM-wide, so it only needs doing once no matter how many clusters
  // exist, but re-running it per registry port is cheap and idempotent.
  if (engine === 'podman') {
    ensureInsecureRegistry(registryPort);
  }

  installIfMissing('k3d', 'k3d', 'k3d-io.k3d');
  installIfMissing('kubectl', 'kubernetes-cli', 'Kubernetes.kubectl');
  installIfMissing('tilt', 'tilt', 'Tilt.dev.tilt');
  installIfMissing('mkcert', 'mkcert', 'FiloSottile.mkcert');
  installIfMissing('helm', 'helm', 'Helm.Helm');

  const registryName = registryNameFor(clusterName);

  if (clusterExists(clusterName)) {
    logger.success(`k3d cluster '${clusterName}' already exists`);
  } else {
    logger.step(`Creating k3d cluster '${clusterName}'...`);
    // Generated fresh per call, not a static file: every Main project needs its own cluster
    // name, ports, and registry mirror name baked in.
    const k3dConfig = {
      apiVersion: 'k3d.io/v1alpha5',
      kind: 'Simple',
      metadata: { name: clusterName },
      servers: 1,
      agents: 0,
      ports: [
        { port: `${httpPort}:80`, nodeFilters: ['loadbalancer'] },
        { port: `${httpsPort}:443`, nodeFilters: ['loadbalancer'] },
      ],
      // Plain container + mirror config, not k3d's built-in `registries.create`: that hard-codes
      // attaching to a network literally named "bridge", which Docker has by default but Podman
      // does not, breaking cluster creation there.
      registries: {
        config: yaml.dump({ mirrors: { [`${registryName}:5000`]: { endpoint: [`http://${registryName}:5000`] } } }),
      },
    };
    const tmpConfig = path.join(os.tmpdir(), `localctl-k3d-config-${clusterName}.yaml`);
    fs.writeFileSync(tmpConfig, yaml.dump(k3dConfig));
    run('k3d', ['cluster', 'create', '--config', tmpConfig, '--wait']);
    fs.rmSync(tmpConfig, { force: true });
    logger.success('Cluster created');
  }
  run('kubectl', ['config', 'use-context', `k3d-${clusterName}`], { stdio: 'ignore' });

  const registryNetwork = `k3d-${clusterName}`;
  const existingNames = capture(engineBin, ['ps', '-a', '--format', '{{.Names}}']).stdout.split('\n');
  if (existingNames.includes(registryName)) {
    logger.success('Registry container already exists');
    run(engineBin, ['start', registryName], { stdio: 'ignore', allowFail: true });
  } else {
    logger.step('Starting local image registry...');
    run(engineBin, [
      'run', '-d',
      '--name', registryName,
      '--network', registryNetwork,
      '-p', `0.0.0.0:${registryPort}:5000`,
      '--restart=always',
      'registry:2',
    ]);
    logger.success(`Registry running at localhost:${registryPort} (in-cluster name: ${registryName}:5000)`);
  }

  // TLS via mkcert - one *.local.test cert/key, shared across every cluster (it's the same
  // domain everywhere; only the namespace/subdomain prefix or the cluster differs).
  logger.step(`Setting up local TLS for *.${DOMAIN}...`);
  run('mkcert', ['-install']);
  const certDir = path.join(os.homedir(), '.localctl', 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const certFile = path.join(certDir, 'local-dev.pem');
  const keyFile = path.join(certDir, 'local-dev-key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    run('mkcert', ['-cert-file', certFile, '-key-file', keyFile, `*.${DOMAIN}`, DOMAIN]);
  }

  const secretYaml = capture('kubectl', [
    'create', 'secret', 'tls', 'local-dev-tls',
    `--cert=${certFile}`, `--key=${keyFile}`,
    '-n', 'kube-system', '--dry-run=client', '-o', 'yaml',
  ]).stdout;
  run('kubectl', ['apply', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'], input: secretYaml });

  // k3d's --wait only waits for node readiness, not for Traefik's helm-install job to finish
  // registering its CRDs, so applying TLSStore any earlier races and fails intermittently.
  logger.step('Waiting for Traefik CRDs...');
  for (let i = 0; i < 60; i += 1) {
    if (capture('kubectl', ['get', 'crd', 'tlsstores.traefik.io']).status === 0) break;
    sleepSync(2000);
  }
  run('kubectl', ['wait', '--for=condition=Established', 'crd/tlsstores.traefik.io', '--timeout=60s'], { stdio: 'ignore' });

  run('kubectl', ['apply', '-f', path.join(MANIFESTS_DIR, 'tls-store.yaml')]);
  run('kubectl', ['apply', '-f', path.join(MANIFESTS_DIR, 'namespace-addons.yaml')]);
  logger.success('TLS configured, default cert wired into Traefik');
}

// Reverses provisionCluster() for one Main project: deletes its cluster, registry container,
// network, and image volume. Does NOT touch the Podman VM's insecure-registry trust (that's
// VM-wide, torn down once by `localctl uninstall`, not per-cluster) or *.local.test hosts/certs
// (shared across every cluster).
function teardownCluster(clusterName) {
  if (commandExists('k3d')) {
    logger.step(`Deleting k3d cluster '${clusterName}'...`);
    run('k3d', ['cluster', 'delete', clusterName], { allowFail: true });
  }
  const detected = detectEngine();
  if (detected) {
    const { bin: engineBin } = detected;
    run(engineBin, ['rm', '-f', '-v', registryNameFor(clusterName)], { stdio: 'ignore', allowFail: true });
    run(engineBin, ['network', 'rm', `k3d-${clusterName}`], { stdio: 'ignore', allowFail: true });
    run(engineBin, ['volume', 'rm', `k3d-${clusterName}-images`], { stdio: 'ignore', allowFail: true });
  }
}

// Throws with the exact fix command if `clusterName` isn't up yet, otherwise points kubectl at
// it. Called by every app-scoped command before it does anything else, so "cd in and run a
// command" fails with a clear instruction instead of a confusing kubectl error further down.
function ensureClusterUp(clusterName, profileName) {
  if (!clusterExists(clusterName)) {
    const fix = profileName === 'default' ? 'localctl setup' : `localctl profiles switch ${profileName}`;
    throw new Error(`No cluster running for project "${profileName}". Run "${fix}" to start it.`);
  }
  run('kubectl', ['config', 'use-context', `k3d-${clusterName}`], { stdio: 'ignore' });
}

module.exports = { provisionCluster, teardownCluster, clusterExists, registryNameFor, ensureClusterUp };
