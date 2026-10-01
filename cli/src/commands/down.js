const fs = require('fs');
const { loadConfig } = require('../lib/loadConfig');
const { run, isRunning, sleepSync } = require('../lib/exec');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { runFiles } = require('../lib/paths');
const logger = require('../lib/logger');

module.exports = (program) => {
  program
    .command('down')
    .description('Tear down the app deployed from the current directory (runs "tilt down")')
    .action(() => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      const { pidFile, portFile, logFile } = runFiles(cfg.name);

      // If `localctl up` started a detached Tilt process for this app, it needs to be stopped
      // first - otherwise it keeps live-syncing/reconciling against resources `tilt down` is
      // about to delete out from under it.
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
        if (Number.isFinite(pid) && isRunning(pid)) {
          logger.step(`Stopping background Tilt process (pid ${pid})...`);
          process.kill(pid, 'SIGTERM');
          for (let i = 0; i < 20 && isRunning(pid); i += 1) sleepSync(250);
        }
        fs.rmSync(pidFile, { force: true });
      }
      fs.rmSync(portFile, { force: true });
      fs.rmSync(logFile, { force: true });

      run('tilt', ['down']);
      logger.success(`"${cfg.name}" torn down. Run "localctl hosts sync" if you want to clean up its subdomain too.`);
    });
};
