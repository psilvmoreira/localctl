const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, capture } = require('./exec');
const logger = require('./logger');

const CONF_PATH = '/etc/containers/registries.conf.d/999-local-dev.conf';

// Native Podman (Linux) has no VM: its registries.conf lives on the host. Rootless Podman reads
// the per-user drop-in directory (no sudo needed); root reads the system one.
function nativeConfPath() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return CONF_PATH;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'containers', 'registries.conf.d', '999-local-dev.conf');
}

// Linux native Podman: no `podman machine`. Containers-image re-reads registries.conf on every
// invocation, so unlike the VM case there's nothing to restart.
function ensureInsecureRegistryNative(hostPort) {
  const file = nativeConfPath();
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.includes(`location = "localhost:${hostPort}"`)) {
    logger.success(`Podman already trusts localhost:${hostPort} as an insecure registry`);
    return;
  }
  logger.step(`Marking localhost:${hostPort} as an insecure registry for Podman (${file})...`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = `${current.trimEnd()}\n\n${registryBlock(hostPort)}`.trim().concat('\n');
  fs.writeFileSync(file, next);
  logger.success('Podman registry config updated');
}

function teardownInsecureRegistryNative() {
  const file = nativeConfPath();
  if (!fs.existsSync(file)) return;
  fs.rmSync(file, { force: true });
  logger.success(`Removed insecure-registry config ${file}`);
}

function isNativePodman() {
  return process.platform === 'linux';
}

function machineName() {
  const res = capture('podman', ['machine', 'list', '--format', '{{.Name}}']);
  const [first] = res.stdout.split('\n').filter(Boolean);
  return first || null;
}

function registryBlock(hostPort) {
  return [
    '[[registry]]',
    `location = "localhost:${hostPort}"`,
    'insecure = true',
    '',
    '[[registry]]',
    `location = "127.0.0.1:${hostPort}"`,
    'insecure = true',
    '',
  ].join('\n');
}

// Podman's daemon runs inside a lightweight VM on macOS/Windows - registries.conf lives inside
// that VM, not on the host, so a host-side config file can't mark our (deliberately TLS-less)
// local registry as insecure. Done before the cluster/registry even exist, because applying it
// needs a VM restart, which would otherwise kill and require restarting every container already
// running.
//
// Appends this port's block to whatever's already there instead of overwriting the file: a
// second Main project (its own registry port) provisioned after the first would otherwise replace
// the first project's trust entry outright, silently breaking its push access the next time
// something tried to use it. One file, one block per port ever provisioned on this machine.
function ensureInsecureRegistry(hostPort) {
  const machine = machineName();
  if (!machine) {
    if (isNativePodman()) ensureInsecureRegistryNative(hostPort);
    return;
  }

  const current = capture('podman', ['machine', 'ssh', machine, `cat ${CONF_PATH} 2>/dev/null`]).stdout;
  if (current.includes(`location = "localhost:${hostPort}"`)) {
    logger.success(`Podman VM already trusts localhost:${hostPort} as an insecure registry`);
    return;
  }

  const next = `${current.trimEnd()}\n\n${registryBlock(hostPort)}`.trim().concat('\n');
  logger.step(`Marking localhost:${hostPort} as an insecure registry inside the Podman VM...`);
  run('podman', ['machine', 'ssh', machine, 'sudo mkdir -p /etc/containers/registries.conf.d']);
  run('podman', ['machine', 'ssh', machine, `sudo tee ${CONF_PATH} > /dev/null`], {
    stdio: ['pipe', 'inherit', 'inherit'],
    input: next,
  });
  logger.step('Restarting Podman machine to apply...');
  run('podman', ['machine', 'stop', machine], { stdio: 'ignore' });
  run('podman', ['machine', 'start', machine], { stdio: 'ignore' });
  logger.success('Podman machine restarted');
}

function teardownInsecureRegistry() {
  const machine = machineName();
  if (!machine) {
    if (isNativePodman()) teardownInsecureRegistryNative();
    return;
  }

  const exists = capture('podman', ['machine', 'ssh', machine, `test -f ${CONF_PATH} && echo yes`]).stdout;
  if (exists.trim() !== 'yes') return;

  logger.step('Removing insecure-registry config from the Podman VM...');
  run('podman', ['machine', 'ssh', machine, `sudo rm -f ${CONF_PATH}`], { stdio: 'ignore', allowFail: true });
  run('podman', ['machine', 'stop', machine], { stdio: 'ignore', allowFail: true });
  run('podman', ['machine', 'start', machine], { stdio: 'ignore', allowFail: true });
  logger.success('Podman VM config removed and machine restarted');
}

// k3d talks to the container engine through the Docker API socket. Docker exposes it by default;
// Podman only when its socket service is running, and k3d finds it through DOCKER_HOST. Points
// DOCKER_HOST at Podman's socket when it exists, and returns a problem description (or null).
function ensurePodmanSocket() {
  if (process.env.DOCKER_HOST) return null;
  const res = capture('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}']);
  const socket = res.status === 0 ? res.stdout.replace(/^unix:\/\//, '') : '';
  if (socket && fs.existsSync(socket)) {
    process.env.DOCKER_HOST = `unix://${socket}`;
    logger.info(`Using the Podman socket at ${socket} (DOCKER_HOST)`);
    return null;
  }
  return 'Podman\'s API socket isn\'t running, which k3d needs. Start it with: systemctl --user enable --now podman.socket';
}

// Rootless Podman can't bind host ports below net.ipv4.ip_unprivileged_port_start (1024 by
// default), and the cluster maps host :80/:443. Returns the ports that will fail to bind.
function blockedPrivilegedPorts(ports) {
  const rootless = capture('podman', ['info', '--format', '{{.Host.Security.Rootless}}']).stdout === 'true';
  if (!rootless) return [];
  let start = 1024;
  try {
    start = parseInt(fs.readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8'), 10);
  } catch (e) {
    // keep the default
  }
  return ports.filter((p) => p < start);
}

// Memory (MB) available to containers: the Podman VM on macOS/Windows, the host on native Linux.
// Returns null when it can't be determined. Docker Desktop's VM size comes from `docker info`.
function engineMemoryMb(engineBin) {
  const res = capture(engineBin, ['info', '--format', '{{.MemTotal}}']);
  const bytes = parseInt(res.stdout, 10);
  if (res.status === 0 && Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / 1024 / 1024);
  const info = capture(engineBin, ['info', '--format', '{{.Host.MemTotal}}']);
  const hostBytes = parseInt(info.stdout, 10);
  return info.status === 0 && Number.isFinite(hostBytes) && hostBytes > 0 ? Math.round(hostBytes / 1024 / 1024) : null;
}

module.exports = {
  engineMemoryMb,
  ensureInsecureRegistry,
  teardownInsecureRegistry,
  ensurePodmanSocket,
  blockedPrivilegedPorts,
};
