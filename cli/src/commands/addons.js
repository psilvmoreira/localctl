const { listAddonNames } = require('../lib/addonDirs');
const { enableClusterAddon, disableClusterAddon, clusterAddonInstances } = require('../lib/clusterAddons');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { getActive, clusterNameFor } = require('../lib/profileStore');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

// Cluster-wide addons apply to whichever project is currently active (see "localctl profiles
// switch") - there's no per-app directory to resolve one from, unlike `app` commands.
function ensureActiveClusterUp() {
  const active = getActive();
  ensureClusterUp(clusterNameFor(active), active);
}

module.exports = (program) => {
  const addons = program.command('addons').description('Manage cluster-wide addons (logging, etc.) in the active project');

  addons
    .command('list')
    .description('List available cluster-wide addons')
    .action(() => {
      listAddonNames('cluster').forEach((n) => console.log(n));
    });

  addons
    .command('enable <name>')
    .description('Enable a cluster-wide addon')
    .action((name) => {
      ensureActiveClusterUp();
      enableClusterAddon(name);
      logger.success(`Addon "${name}" applied.`);
    });

  addons
    .command('disable <name>')
    .description('Remove a cluster-wide addon')
    .action((name) => {
      ensureActiveClusterUp();
      disableClusterAddon(name);
      logger.success(`Addon "${name}" removed.`);
    });

  addons
    .command('status')
    .description('Show every addon instance in the cluster - infrastructure helpers, separate from your apps')
    .action(() => {
      ensureActiveClusterUp();
      const records = clusterAddonInstances();
      if (records.length === 0) {
        logger.info('No addon instances found in the cluster.');
        return;
      }
      const rows = records.map((r) => [r.release, r.owner || ui.dim('(cluster-wide)'), r.namespace, r.chart, r.ready]);
      ui.printTable(['ADDON', 'OWNER', 'NAMESPACE', 'CHART', 'READY'], rows);
    });
};
