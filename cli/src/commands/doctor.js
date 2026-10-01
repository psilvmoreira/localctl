const { commandExists, capture } = require('../lib/exec');
const { detectEngine } = require('../lib/engine');
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
      const detected = detectEngine();
      check(`container engine available${detected ? ` (${detected.engine})` : ''}`, () => Boolean(detected));
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
      check('kubectl context reachable', () => capture('kubectl', ['cluster-info']).status === 0);
      logger.step(`Fix any ${ui.cross} above, or run "localctl setup" (or "localctl profiles switch ${active}" for a non-default project) to (re)install/repair.`);
    });
};
