const { syncHosts, clearHosts, listApps } = require('../lib/hostsFile');
const { DOMAIN } = require('../lib/constants');

module.exports = (program) => {
  const hosts = program.command('hosts').description(`Manage local hosts file entries for *.${DOMAIN} apps`);

  hosts
    .command('sync')
    .description('Sync the hosts file with all registered app subdomains')
    .action(() => syncHosts());

  hosts
    .command('list')
    .description('List registered subdomains')
    .action(() => {
      listApps().forEach((s) => console.log(`${s}.${DOMAIN}`));
    });

  hosts
    .command('clear')
    .description(`[used by uninstall] Remove the entire managed *.${DOMAIN} block from the hosts file`)
    .action(() => clearHosts());
};
