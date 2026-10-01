const fs = require('fs');
const { loadConfig } = require('../lib/loadConfig');
const { syncHosts, registerApp } = require('../lib/hostsFile');
const { run, capture, sleepSync, spawnDetached, getFreePort, isRunning } = require('../lib/exec');
const { detectEngine } = require('../lib/engine');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { portsFor } = require('../lib/profileStore');
const { listKeys } = require('../lib/appSecrets');
const { runFiles } = require('../lib/paths');
const { DOMAIN, DEFAULT_HTTPS_PORT } = require('../lib/constants');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

function podmanBuildEnv() {
  const env = { ...process.env };
  const detected = detectEngine();
  if (detected && detected.engine === 'podman') {
    // Podman's Docker-API-compat socket doesn't implement BuildKit's gRPC build protocol
    // (Tilt's docker_build fails with "unable to upgrade to h2c" otherwise).
    env.DOCKER_BUILDKIT = '0';
    logger.info('Podman detected: disabling BuildKit for this build.');
  }
  return env;
}

function printEndpoints(cfg) {
  const { httpsPort } = portsFor(cfg.profile);
  const suffix = httpsPort === DEFAULT_HTTPS_PORT ? '' : `:${httpsPort}`;
  const url = `https://${cfg.subdomain}.${DOMAIN}${suffix}`;
  console.log('');
  console.log(`${ui.check} ${ui.bold(cfg.name)} -> ${ui.url(url)}`);
  if (cfg.debug.enabled && cfg.debug.port) {
    console.log(`  debug:  localhost:${cfg.debug.port}`);
  }
  console.log(`  logs:   localctl app logs ${cfg.name} -f`);
  console.log(`  status: localctl app status`);
  console.log(`  stop:   localctl app down`);
  console.log('');
}

function tailLog(logFile, lines) {
  if (!fs.existsSync(logFile)) return null;
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-lines).join('\n');
}

module.exports = (program) => {
  program
    .command('up')
    .option('-f, --foreground', 'run in the foreground with the interactive Tilt UI (default: detached, survives closing this terminal)')
    .description('Deploy/dev-loop the app in the current directory')
    .action(async (opts) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);

      if (cfg.secrets.length > 0) {
        const set = new Set(listKeys(cfg));
        const missing = cfg.secrets.filter((key) => !set.has(key));
        if (missing.length > 0) {
          throw new Error(
            `Missing secret value${missing.length > 1 ? 's' : ''} for: ${missing.join(', ')}. Set ` +
            `${missing.length > 1 ? 'them' : 'it'} first:\n` +
            missing.map((key) => `  localctl app secrets set ${key}`).join('\n'),
          );
        }
      }

      registerApp(cfg.subdomain);
      syncHosts();
      const env = podmanBuildEnv();

      // Each app gets its own Tilt web UI port. Tilt's default (10350) is shared/fixed, so two
      // apps running `localctl up` at once - the whole point of detached mode - would otherwise
      // collide outright, and Tilt's resulting error doesn't explain why to someone who never
      // asked to think about Tilt's own dashboard port in the first place.
      const tiltPort = await getFreePort();

      if (opts.foreground) {
        logger.step(`Starting Tilt for "${cfg.name}" -> https://${cfg.subdomain}.${DOMAIN}`);
        run('tilt', ['up', '--port', String(tiltPort)], { env });
        return;
      }

      const { pidFile, portFile, logFile } = runFiles(cfg.name);
      const pid = spawnDetached('tilt', ['up', '--port', String(tiltPort)], { cwd: process.cwd(), env, logFile });
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(portFile, String(tiltPort));
      logger.step(`Starting Tilt for "${cfg.name}" in the background (pid ${pid})...`);
      logger.info(`Full Tilt output: tail -f ${logFile}`);

      logger.step('Waiting for the deployment to become ready...');
      // Tilt needs a moment to apply the generated manifests - "rollout status" errors outright
      // on a Deployment that doesn't exist yet, it doesn't wait for one to appear.
      let exists = false;
      for (let i = 0; i < 30; i += 1) {
        if (capture('kubectl', ['get', 'deployment', cfg.name, '-n', cfg.namespace]).status === 0) {
          exists = true;
          break;
        }
        if (!isRunning(pid)) break; // Tilt already died - no point waiting out the rest of the poll
        sleepSync(1000);
      }

      const rollout = exists
        ? run(
            'kubectl',
            ['rollout', 'status', `deployment/${cfg.name}`, '-n', cfg.namespace, '--timeout=180s'],
            { allowFail: true },
          )
        : { status: 1 };

      if (rollout.status === 0) {
        printEndpoints(cfg);
        return;
      }

      if (!isRunning(pid)) {
        logger.warn(`Tilt exited before the deployment came up. Last lines of ${logFile}:`);
        console.log(ui.dim(tailLog(logFile, 15) || '(log file is empty)'));
      } else {
        logger.warn(`Still starting (or something's wrong) - check "localctl app logs ${cfg.name} -f" or "localctl app status".`);
      }
    });
};
