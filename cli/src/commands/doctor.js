const { commandExists, capture } = require('../lib/exec');
const { detectEngine, warnIfExperimental, warnIfExperimentalPlatform } = require('../lib/engine');
const { ensurePodmanSocket, blockedPrivilegedPorts, engineMemoryMb } = require('../lib/podman');
const { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } = require('../lib/constants');
const { getActive, clusterNameFor } = require('../lib/profileStore');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

function check(label, fn) {
  try {
    const passed = fn();
    console.log(`  ${passed ? ui.check : ui.cross} ${label}`);
    return passed;
  } catch (e) {
    console.log(`  ${ui.cross} ${label} - ${ui.dim(e.message)}`);
    return false;
  }
}

module.exports = (program) => {
  program
    .command('doctor')
    .description('Check the local environment for missing/broken pieces')
    .action(() => {
      logger.step('Checking environment...');
      warnIfExperimentalPlatform();
      const detected = detectEngine();
      check(`container engine available${detected ? ` (${detected.engine})` : ''}`, () => Boolean(detected));
      if (detected) warnIfExperimental(detected.engine);
      if (detected && detected.engine === 'podman') {
        logger.info('Podman detected: "localctl app up" will disable BuildKit automatically for image builds.');
      }
      check('k3d installed', () => commandExists('k3d'));
      check('kubectl installed', () => commandExists('kubectl'));
      check('tilt installed', () => commandExists('tilt'));
      check('mkcert installed', () => commandExists('mkcert'));
      check('helm installed', () => commandExists('helm'));
      const active = getActive();
      const activeCluster = clusterNameFor(active);
      check(`active project's cluster exists ("${active}" -> ${activeCluster})`, () => {
        const res = capture('k3d', ['cluster', 'list']);
        return res.stdout.split('\n').some((line) => line.trim().split(/\s+/)[0] === activeCluster);
      });
      if (process.platform === 'linux' && detected && detected.engine === 'podman') {
        check('podman API socket available (needed by k3d)', () => ensurePodmanSocket() === null);
        check('rootless podman can bind :80/:443', () => blockedPrivilegedPorts([DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT]).length === 0);
      }
      if (detected) {
        // One k3s cluster idles around 0.6-0.7 GB, and apps/addons come on top. Below ~3 GB the
        // engine's VM starts swapping and the API server times out.
        const mb = engineMemoryMb(detected.bin);
        if (mb !== null) {
          check(`engine has at least 3 GB of memory (${(mb / 1024).toFixed(1)} GB available)`, () => mb >= 3000);
        }
      }
      check('kubectl context reachable', () => capture('kubectl', ['cluster-info']).status === 0);
      logger.step(`Fix any ${ui.cross} above, or run "localctl setup" (or "localctl profiles switch ${active}" for a non-default project) to (re)install/repair.`);
    });
};
