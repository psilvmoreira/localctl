const { run, capture } = require('./exec');
const logger = require('./logger');

const CONF_PATH = '/etc/containers/registries.conf.d/999-local-dev.conf';

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
  if (!machine) return;

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
  if (!machine) return;

  const exists = capture('podman', ['machine', 'ssh', machine, `test -f ${CONF_PATH} && echo yes`]).stdout;
  if (exists.trim() !== 'yes') return;

  logger.step('Removing insecure-registry config from the Podman VM...');
  run('podman', ['machine', 'ssh', machine, `sudo rm -f ${CONF_PATH}`], { stdio: 'ignore', allowFail: true });
  run('podman', ['machine', 'stop', machine], { stdio: 'ignore', allowFail: true });
  run('podman', ['machine', 'start', machine], { stdio: 'ignore', allowFail: true });
  logger.success('Podman VM config removed and machine restarted');
}

module.exports = { ensureInsecureRegistry, teardownInsecureRegistry };
