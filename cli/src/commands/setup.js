const { provisionCluster } = require('../lib/clusterProvision');
const { syncHosts } = require('../lib/hostsFile');
const { setActive } = require('../lib/profileStore');
const { DEFAULT_CLUSTER_NAME, DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT, DOMAIN, REGISTRY_HOST_PORT } = require('../lib/constants');
const logger = require('../lib/logger');

function setup() {
  provisionCluster({
    clusterName: DEFAULT_CLUSTER_NAME,
    httpPort: DEFAULT_HTTP_PORT,
    httpsPort: DEFAULT_HTTPS_PORT,
    registryPort: REGISTRY_HOST_PORT,
  });
  setActive('default');

  // Hosts file: seed it now (prompts for sudo here, once, instead of surprising you mid
  // `localctl app up` later). Only adds `local.test` itself at this point - per-app subdomains get
  // added the same way when you run `localctl app new`/`up` for each app.
  logger.step('Syncing hosts file...');
  syncHosts();

  console.log();
  logger.success('Setup complete.');
  console.log('Next steps:');
  console.log('  1. cd into an app repo');
  console.log('  2. localctl app new');
  console.log('  3. localctl app up');
  console.log(`  4. open https://<subdomain>.${DOMAIN}`);
}

module.exports = (program) => {
  program
    .command('setup')
    .description('One-click local infra setup for the default project: container engine, tools, k3d cluster, TLS, hosts')
    .action(setup);
};
