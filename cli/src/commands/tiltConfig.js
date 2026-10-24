const { loadConfig } = require('../lib/loadConfig');
const { tiltConfig } = require('../lib/tiltConfig');

module.exports = (program) => {
  program
    .command('tilt-config')
    .description('[internal, called by Tiltfile] Print the resolved build/sync/port settings of the app in the current directory as JSON')
    .action(() => {
      process.stdout.write(JSON.stringify(tiltConfig(loadConfig())));
    });
};
