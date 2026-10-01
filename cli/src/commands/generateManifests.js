const { loadConfig } = require('../lib/loadConfig');
const { generateManifests } = require('../lib/manifestGen');

module.exports = (program) => {
  program
    .command('generate-manifests')
    .description('[internal, called by Tiltfile] Render k8s manifests for the app in the current directory to stdout')
    .action(() => {
      const cfg = loadConfig();
      process.stdout.write(generateManifests(cfg));
    });
};
