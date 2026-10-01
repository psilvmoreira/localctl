const { loadConfig } = require('../lib/loadConfig');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { run, capture } = require('../lib/exec');
const { getList } = require('../lib/workloadReadiness');
const { confirm } = require('../lib/prompt');
const logger = require('../lib/logger');

module.exports = (program) => {
  program
    .command('prune')
    .option('-y, --yes', 'skip the confirmation prompt')
    .description('Permanently delete an already-torn-down app\'s leftover data (dependency PVCs, secrets) - "app down" deliberately leaves these alone')
    .action(async (opts) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);

      if (capture('kubectl', ['get', 'deployment', cfg.name, '-n', cfg.namespace]).status === 0) {
        throw new Error(`"${cfg.name}" is still deployed - run "localctl app down" first, then "localctl app prune" to also wipe its data.`);
      }
      if (capture('kubectl', ['get', 'namespace', cfg.namespace]).status !== 0) {
        logger.info(`Nothing to prune - namespace "${cfg.namespace}" doesn't exist.`);
        return;
      }

      const pvcs = getList(['get', 'pvc', '-n', cfg.namespace]);
      const secrets = getList(['get', 'secret', '-n', cfg.namespace]).filter((s) => s.type !== 'kubernetes.io/service-account-token');
      if (pvcs.length === 0 && secrets.length === 0) {
        logger.info(`Nothing left to prune in "${cfg.namespace}".`);
        return;
      }

      console.log(`This will permanently delete everything left in namespace "${cfg.namespace}":`);
      pvcs.forEach((p) => console.log(`  - PersistentVolumeClaim/${p.metadata.name} (data loss)`));
      secrets.forEach((s) => console.log(`  - Secret/${s.metadata.name}`));
      console.log('');

      if (!opts.yes) {
        const answer = await confirm('Continue? [y/N] ');
        if (!/^y(es)?$/i.test(answer)) {
          console.log('Aborted.');
          process.exitCode = 1;
          return;
        }
      }

      run('kubectl', ['delete', 'namespace', cfg.namespace]);
      logger.success(`Namespace "${cfg.namespace}" and everything in it deleted.`);
    });
};
