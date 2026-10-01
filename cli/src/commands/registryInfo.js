const { loadConfig } = require('../lib/loadConfig');
const { portsFor, mainProjectFor } = require('../lib/profileStore');
const { registryNameFor } = require('../lib/clusterProvision');

module.exports = (program) => {
  program
    .command('registry-info')
    .description('[internal, called by Tiltfile] Print this app\'s registry push/pull addresses as JSON')
    .action(() => {
      const cfg = loadConfig();
      const { registryPort } = portsFor(cfg.profile);
      const { def } = mainProjectFor(cfg.profile);
      process.stdout.write(JSON.stringify({
        pushHost: `localhost:${registryPort}`,
        clusterHost: `${registryNameFor(def.cluster)}:5000`,
      }));
    });
};
