const fs = require('fs');
const { run } = require('../lib/exec');
const { loadConfig } = require('../lib/loadConfig');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { getActive, clusterNameFor } = require('../lib/profileStore');
const { CONFIG_PATH } = require('../lib/paths');

module.exports = (program) => {
  program
    .command('logs [name]')
    .option('-n, --namespace <ns>', 'namespace override (only needed outside an app\'s own repo, or if it disagrees with what "localctl app status" shows)')
    .option('-f, --follow', 'follow log output')
    .description('Tail logs for a deployed app - run inside the app\'s repo to resolve it (and its project\'s namespace prefix) automatically, or pass a name')
    .action((name, opts) => {
      let targetName = name;
      let namespace = opts.namespace;

      if (!namespace) {
        if (!targetName && fs.existsSync(CONFIG_PATH)) {
          // Directory-resolved, same as `app status`/`up`/`down` - this is what a namespace-scoped
          // project needs: its real namespace is "<scope>-<name>", not the bare app name a plain
          // `-n <name>` default would guess.
          const cfg = loadConfig();
          ensureClusterUp(cfg.clusterName, cfg.profile);
          targetName = cfg.name;
          namespace = cfg.namespace;
        } else if (targetName) {
          // An explicit name from outside its own repo - no directory to resolve from, so this
          // stays a best-effort guess (namespace = name) against the active project's cluster,
          // same fallback `app status -a <name>` uses.
          const active = getActive();
          ensureClusterUp(clusterNameFor(active), active);
          namespace = targetName;
        }
      }

      if (!targetName) {
        throw new Error('Run this from inside an app repo, or pass a name (localctl app logs <name>).');
      }

      const args = ['logs', `deploy/${targetName}`, '-n', namespace];
      if (opts.follow) args.push('-f');
      run('kubectl', args);
    });
};
