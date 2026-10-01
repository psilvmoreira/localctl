const { loadConfig } = require('../lib/loadConfig');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { run } = require('../lib/exec');

module.exports = (program) => {
  program
    .command('exec [cmd...]')
    .description('Shell into the running app\'s pod (kubectl exec) - defaults to "sh" if no command is given')
    .action((cmd) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      const command = cmd && cmd.length ? cmd : ['sh'];
      run('kubectl', ['exec', '-it', `deploy/${cfg.name}`, '-n', cfg.namespace, '--', ...command]);
    });
};
