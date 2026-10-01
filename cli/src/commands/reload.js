const fs = require('fs');
const { CONFIG_PATH, runFiles } = require('../lib/paths');
const { run, isRunning } = require('../lib/exec');
const logger = require('../lib/logger');

function resolveAppName(opts) {
  if (opts.app) return opts.app;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).name;
    } catch (e) {
      // fall through
    }
  }
  return null;
}

module.exports = (program) => {
  program
    .command('reload')
    .option('-a, --app <name>', 'reload a specific app by name, regardless of the current directory')
    .description('Force an immediate rebuild/redeploy of a running background dev loop, without waiting on a file change')
    .action((opts) => {
      const name = resolveAppName(opts);
      if (!name) {
        throw new Error('Run this from inside an app repo, or pass -a <name>.');
      }

      const { pidFile, portFile } = runFiles(name);
      if (!fs.existsSync(pidFile) || !fs.existsSync(portFile)) {
        throw new Error(`No background dev loop tracked for "${name}". Run "localctl app up" first (reload only works in detached mode, not "-f/--foreground").`);
      }

      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (!Number.isFinite(pid) || !isRunning(pid)) {
        throw new Error(`"${name}"'s dev loop isn't running. Run "localctl app up" to start it.`);
      }

      const port = fs.readFileSync(portFile, 'utf8').trim();
      logger.step(`Triggering an immediate rebuild/redeploy for "${name}"...`);
      run('tilt', ['trigger', '--port', port, name]);
      logger.success(`"${name}" reload triggered - check "localctl app logs ${name} -f" for progress.`);
    });
};
