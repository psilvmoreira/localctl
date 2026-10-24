const { loadConfig } = require('../lib/loadConfig');
const { generateManifests } = require('../lib/manifestGen');
const { assertNamespaceOwnership } = require('../lib/namespaces');

module.exports = (program) => {
  program
    .command('generate-manifests')
    .description('[internal, called by Tiltfile] Render k8s manifests for the app in the current directory to stdout')
    .action(() => {
      const cfg = loadConfig();
      // Rendering creates Secrets and ConfigMaps for dependencies, so check the namespace first:
      // Tilt calls this on every evaluation, whatever `localctl app up` checked earlier.
      assertNamespaceOwnership(cfg);
      process.stdout.write(generateManifests(cfg));
    });
};
