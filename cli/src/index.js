const { Command } = require('commander');

const program = new Command();
program
  .name('localctl')
  .description('Local Kubernetes dev platform CLI')
  .version('0.1.0');

// Global/machine-level - not tied to any one app or addon.
require('./commands/setup')(program);
require('./commands/uninstall')(program);
require('./commands/doctor')(program);
require('./commands/hosts')(program);

// Feature-level command groups.
const app = program.command('app').description('Manage a single app: scaffold, deploy, monitor');
require('./commands/new')(app);
require('./commands/up')(app);
require('./commands/down')(app);
require('./commands/status')(app);
require('./commands/logs')(app);
require('./commands/reload')(app);
require('./commands/generateManifests')(app);
require('./commands/registryInfo')(app);
require('./commands/exec')(app);
require('./commands/prune')(app);
require('./commands/secrets')(app); // its own subgroup: set/unset/list/show

require('./commands/addons')(program); // already its own group: list/enable/disable/status
require('./commands/profiles')(program); // already its own group: new/list/switch/status

program.parseAsync(process.argv).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
