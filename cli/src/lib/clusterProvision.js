const os = require('os');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { run, capture, sleepSync, commandExists } = require('./exec');
const { detectEngine, warnIfExperimental, warnIfExperimentalPlatform } = require('./engine');
const { installIfMissing, installTiltWindows, nssInstallHint } = require('./toolInstall');
const { ensureInsecureRegistry, ensurePodmanSocket, blockedPrivilegedPorts } = require('./podman');
const { DOMAIN } = require('./constants');
const logger = require('./logger');
const { CERTS_DIR } = require('./paths');
const { detectDistro, dockerInstallSteps } = require('./linuxDistro');

// Cluster-level manifests: bundled under cli/assets/ in the npm package (copied there by
// scripts/sync-assets.js at pack time), or read straight from the repo root in a git checkout.
const BUNDLED_MANIFESTS_DIR = path.resolve(__dirname, '..', '..', 'assets', 'manifests');
const MANIFESTS_DIR = fs.existsSync(BUNDLED_MANIFESTS_DIR)
  ? BUNDLED_MANIFESTS_DIR
  : path.resolve(__dirname, '..', '..', '..', 'cluster', 'manifests');

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch (e) {
    return false;
  }
}

function registryNameFor(clusterName) {
  return `${clusterName}-registry`;
}

function clusterExists(clusterName) {
  return capture('k3d', ['cluster', 'list']).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .includes(clusterName);
}

// k3d writes the API server as https://0.0.0.0:<port> into kubeconfig. Linux and Windows treat
// 0.0.0.0 as "this host", but macOS refuses to connect to it ("can't assign requested address"),
// so every kubectl call fails. Selects the cluster's context and points it at 127.0.0.1 instead,
// which also repairs clusters created before this fix.
function useClusterContext(clusterName) {
  const context = `k3d-${clusterName}`;
  // The cluster can exist while this kubeconfig knows nothing about it (a deleted or replaced
  // ~/.kube/config, a different KUBECONFIG): ask k3d to write it back instead of failing.
  const known = capture('kubectl', ['config', 'get-contexts', '-o', 'name']).stdout.split('\n');
  if (!known.includes(context)) {
    run('k3d', ['kubeconfig', 'merge', clusterName, '--kubeconfig-merge-default'], { stdio: 'ignore', allowFail: true });
  }
  run('kubectl', ['config', 'use-context', context], { stdio: 'ignore' });
  const server = capture('kubectl', [
    'config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}',
  ]).stdout;
  if (server.includes('//0.0.0.0:')) {
    run('kubectl', [
      'config', 'set-cluster', context, `--server=${server.replace('//0.0.0.0:', '//127.0.0.1:')}`,
    ], { stdio: 'ignore' });
  }
}

// Generated fresh per call, not a static file: every Main project needs its own cluster name,
// ports, and registry mirror name baked in.
function buildK3dConfig({ clusterName, httpPort, httpsPort, registryName }) {
  return {
    apiVersion: 'k3d.io/v1alpha5',
    kind: 'Simple',
    metadata: { name: clusterName },
    servers: 1,
    agents: 0,
    ports: [
      { port: `${httpPort}:80`, nodeFilters: ['loadbalancer'] },
      { port: `${httpsPort}:443`, nodeFilters: ['loadbalancer'] },
    ],
    options: {
      k3s: {
        // metrics-server only feeds `kubectl top` and HPAs, which a local dev loop doesn't use;
        // dropping it saves memory. servicelb must stay: it's what opens :80/:443 on the node for
        // Traefik's LoadBalancer Service, so disabling it would break every ingress.
        extraArgs: [{ arg: '--disable=metrics-server', nodeFilters: ['server:*'] }],
      },
    },
    // Plain container + mirror config, not k3d's built-in `registries.create`: that hard-codes
    // attaching to a network literally named "bridge", which Docker has by default but Podman
    // does not, breaking cluster creation there.
    registries: {
      config: yaml.dump({ mirrors: { [`${registryName}:5000`]: { endpoint: [`http://${registryName}:5000`] } } }),
    },
  };
}

// Right after a (re)start the load balancer can accept connections before the API server is
// answering (EOF / connection refused), so wait for it before the first real kubectl call.
// Also after an engine restart the server container can get a new IP while the load balancer
// (nginx, resolves upstreams only at startup) keeps the old one, so the API never answers;
// restarting the load balancer once re-resolves it. Returns true once the API is ready.
function waitForClusterApi(engineBin, clusterName, { attempts = 60, quiet = false } = {}) {
  if (!quiet) logger.step('Waiting for the Kubernetes API...');
  let lbRestarted = false;
  for (let i = 0; i < attempts; i += 1) {
    if (capture('kubectl', ['get', '--raw', '/readyz']).status === 0) return true;
    if (i === 5 && !lbRestarted) {
      lbRestarted = true;
      run(engineBin, ['restart', `k3d-${clusterName}-serverlb`], { stdio: 'ignore', allowFail: true });
    }
    sleepSync(2000);
  }
  return false;
}

// k3d's --wait only waits for node readiness, not for Traefik's helm-install job to finish
// registering its CRDs, so applying TLSStore any earlier races and fails intermittently. On a slow
// machine (first image pulls, a nested engine) that takes minutes, so poll for the CRD to be
// *Established* instead of giving up after one fixed wait, and say why if it never is.
function waitForTraefikCrds(attempts = 150) {
  logger.step('Waiting for Traefik CRDs...');
  let last = 'not found yet';
  for (let i = 0; i < attempts; i += 1) {
    const r = capture('kubectl', [
      'get', 'crd', 'tlsstores.traefik.io',
      '-o', 'jsonpath={.status.conditions[?(@.type=="Established")].status}',
    ]);
    if (r.status === 0 && r.stdout === 'True') return;
    last = r.status === 0 ? `Established=${r.stdout || 'unknown'}` : (r.stderr.split('\n')[0] || 'not found yet');
    sleepSync(2000);
  }
  throw new Error(
    `Traefik's CRDs (tlsstores.traefik.io) were not ready after ${Math.round((attempts * 2) / 60)} minutes (${last}). ` +
    'Check "kubectl -n kube-system get pods" - the traefik helm-install jobs are probably still pulling images.',
  );
}

// The CRDs existing does not mean Traefik is serving: on a slow machine its pod can still be
// starting minutes later, and an app deployed in that window answers with a dropped connection.
// Waiting here makes "cluster ready" mean the ingress actually accepts traffic.
function waitForTraefik(attempts = 150) {
  logger.step('Waiting for Traefik to accept traffic...');
  for (let i = 0; i < attempts; i += 1) {
    if (capture('kubectl', ['get', 'deployment', 'traefik', '-n', 'kube-system']).status === 0) break;
    sleepSync(2000);
  }
  const res = capture('kubectl', ['rollout', 'status', 'deployment/traefik', '-n', 'kube-system', '--timeout=300s']);
  if (res.status !== 0) {
    throw new Error(
      `Traefik did not become ready in 5 minutes (${(res.stderr || res.stdout).split('\n')[0]}). ` +
      'Check "kubectl -n kube-system get pods".',
    );
  }
}

// A CRD can be Established a moment before the API server's discovery serves it, which surfaces as
// "no matches for kind". Retrying the apply covers that window.
function applyWithRetry(file, attempts = 15) {
  let res;
  for (let i = 0; i < attempts; i += 1) {
    res = capture('kubectl', ['apply', '-f', file]);
    if (res.status === 0) {
      if (res.stdout) console.log(res.stdout);
      return;
    }
    sleepSync(2000);
  }
  throw new Error(`kubectl apply -f ${path.basename(file)} failed after ${attempts} attempts: ${res.stderr}`);
}

// Brings up (idempotently) one Main project's cluster: container engine + tool checks, the k3d
// cluster itself (own ports, since two clusters can't both bind host :80/:443), its own local
// registry container, and the shared *.local.test TLS cert wired into its Traefik. Used by both
// `localctl setup` (the "default" profile, unchanged ports/names from before multi-project
// support) and `localctl profiles new`/`switch` (any other Main project).
function provisionCluster({ clusterName, httpPort, httpsPort, registryPort }) {
  warnIfExperimentalPlatform();
  if (isWsl()) {
    logger.warn('WSL detected: browsers on Windows read C:\\Windows\\System32\\drivers\\etc\\hosts, not this distro\'s /etc/hosts, and WSL may regenerate /etc/hosts on restart. Add the *.local.test entries to the Windows hosts file too (localctl prints them), or run localctl from Windows instead.');
  }
  logger.step('Detecting container engine...');
  const detected = detectEngine();
  if (!detected) {
    let linuxHint = '';
    if (process.platform === 'linux') {
      if (commandExists('docker') || commandExists('podman')) {
        // Installed but not usable: reinstalling won't help, the daemon or permissions are the issue.
        linuxHint = '\nA container engine is installed but not responding. Start the service' +
          ' (`sudo systemctl enable --now docker`, or `systemctl --user enable --now podman.socket` for Podman;' +
          ' without systemd, start `dockerd` yourself) and make sure your user can reach it' +
          ' (member of the "docker" group, then log out and in).';
      } else {
        const { family, id } = detectDistro();
        const steps = dockerInstallSteps(family, id);
        linuxHint = steps
          ? `\nTo install Docker Engine, run "localctl setup --install-docker", or by hand:\n  ${steps.join('\n  ')}`
          : '\nInstall Docker Engine for your distro: https://docs.docker.com/engine/install/';
      }
    }
    throw new Error(`No running container engine found. Start Docker Desktop, Podman, or Rancher Desktop and re-run.${linuxHint}`);
  }
  const { engine, bin: engineBin } = detected;
  logger.success(`Using container engine: ${engine} (${engineBin} CLI)`);
  warnIfExperimental(engine);

  // Podman-specific, and must happen before the cluster/registry exist - see lib/podman.js. The
  // insecure-registry trust is VM-wide, so it only needs doing once no matter how many clusters
  // exist, but re-running it per registry port is cheap and idempotent.
  if (engine === 'podman') {
    ensureInsecureRegistry(registryPort);
    if (process.platform === 'linux') {
      const socketProblem = ensurePodmanSocket();
      if (socketProblem) logger.warn(socketProblem);
      const blocked = blockedPrivilegedPorts([httpPort, httpsPort]);
      if (blocked.length) {
        logger.warn(`Rootless Podman can't bind host port(s) ${blocked.join(', ')}. Allow it with: sudo sysctl net.ipv4.ip_unprivileged_port_start=80 (add it to /etc/sysctl.d/ to persist).`);
      }
    }
  }

  installIfMissing('k3d', 'k3d', 'k3d.k3d');
  installIfMissing('kubectl', 'kubernetes-cli', 'Kubernetes.kubectl');
  installIfMissing('tilt', 'tilt', installTiltWindows);
  installIfMissing('mkcert', 'mkcert', 'FiloSottile.mkcert');
  installIfMissing('helm', 'helm', 'Helm.Helm');
  // mkcert can only add its CA to Firefox's trust store when NSS's certutil is present. It's
  // optional (Safari/Chrome don't need it), so a failed or impossible install - e.g. no Homebrew -
  // only warns. macOS installs it automatically; Linux needs sudo, so it only prints the command.
  if (!commandExists('certutil')) {
    if (process.platform === 'darwin') {
      if (commandExists('brew')) {
        try {
          installIfMissing('certutil', 'nss');
        } catch (e) {
          logger.warn(`Couldn't install nss (${e.message}). Firefox won't trust the local CA until you run "brew install nss && mkcert -install".`);
        }
      } else {
        logger.warn('Homebrew not found, skipping nss. Firefox won\'t trust the local CA until certutil is installed and "mkcert -install" is re-run.');
        logger.info('Tip: install Homebrew (https://brew.sh) so localctl can install missing tools for you, then run "brew install nss".');
      }
    } else if (process.platform === 'linux') {
      logger.warn(`certutil not found, so Firefox/Chromium won't trust the local CA. Install it with: ${nssInstallHint()} - then re-run "mkcert -install".`);
    }
  }

  const registryName = registryNameFor(clusterName);

  if (clusterExists(clusterName)) {
    logger.success(`k3d cluster '${clusterName}' already exists`);
    // A reboot or engine restart leaves the cluster stopped; `start` is a no-op when it's running.
    run('k3d', ['cluster', 'start', clusterName, '--wait'], { stdio: 'ignore', allowFail: true });
  } else {
    logger.step(`Creating k3d cluster '${clusterName}'...`);
    const k3dConfig = buildK3dConfig({ clusterName, httpPort, httpsPort, registryName });
    const tmpConfig = path.join(os.tmpdir(), `localctl-k3d-config-${clusterName}.yaml`);
    fs.writeFileSync(tmpConfig, yaml.dump(k3dConfig));
    run('k3d', ['cluster', 'create', '--config', tmpConfig, '--wait']);
    fs.rmSync(tmpConfig, { force: true });
    logger.success('Cluster created');
  }
  useClusterContext(clusterName);

  // Up to ~5 minutes: k3s can exit once during start-up (a known race between its cloud controller
  // and RBAC bootstrap) and is restarted by the engine, which a 2-minute wait would not outlast on
  // a slow machine. If it never answers, stop here with the reason instead of failing later on an
  // unrelated "EOF" from kubectl apply.
  if (!waitForClusterApi(engineBin, clusterName, { attempts: 150 })) {
    throw new Error(
      `The Kubernetes API of cluster '${clusterName}' did not become ready in 5 minutes. ` +
      `See why with: ${engineBin} logs --tail 50 k3d-${clusterName}-server-0`,
    );
  }

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
  const certDir = CERTS_DIR;
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
  waitForTraefikCrds();
  applyWithRetry(path.join(MANIFESTS_DIR, 'tls-store.yaml'));
  applyWithRetry(path.join(MANIFESTS_DIR, 'namespace-addons.yaml'));
  waitForTraefik();
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
  useClusterContext(clusterName);
}

module.exports = { buildK3dConfig, useClusterContext, waitForClusterApi, provisionCluster, teardownCluster, clusterExists, registryNameFor, ensureClusterUp };
