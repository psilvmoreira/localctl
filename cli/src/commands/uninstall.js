const os = require('os');
const fs = require('fs');
const path = require('path');
const { isRunning } = require('../lib/exec');
const { detectEngine } = require('../lib/engine');
const { teardownCluster, clusterExists } = require('../lib/clusterProvision');
const { teardownInsecureRegistry } = require('../lib/podman');
const { clearHosts } = require('../lib/hostsFile');
const { listProfiles } = require('../lib/profileStore');
const { confirm } = require('../lib/prompt');
const { RUN_DIR, PROFILES_PATH } = require('../lib/paths');
const logger = require('../lib/logger');

// Every Main (cluster-isolation) project this machine knows about - each one owns a real,
// separate cluster that needs tearing down individually.
function mainProjects() {
  return Object.entries(listProfiles())
    .filter(([, def]) => def.isolation === 'cluster')
    .map(([name, def]) => ({ name, cluster: def.cluster }));
}

async function uninstall(opts) {
  const projects = mainProjects();
  console.log('This will remove everything "localctl setup"/"localctl profiles" set up:');
  console.log(`  - Every project's k3d cluster (${projects.map((p) => p.cluster).join(', ')}) and everything deployed in them`);
  console.log('  - Their local image registry containers');
  console.log('  - Podman VM insecure-registry config (Podman only, if present)');
  console.log('  - The *.local.test block in your hosts file');
  console.log('  - Any background dev loop `localctl app up` left running, and its state');
  console.log('  - ~/.localctl/certs, the app registry state, and the project registry (~/.localctl/profiles.json)');
  console.log('');
  console.log("It will NOT remove: k3d, kubectl, tilt, mkcert, node, the localctl CLI itself, or");
  console.log("mkcert's root CA trust. To remove the CLI too, use whichever matches how you");
  console.log('installed it: `npm uninstall -g @localctl/cli`, or `bin/uninstall.sh` /');
  console.log("`uninstall.ps1` if you used bin/bootstrap.sh's PATH shim instead.");
  console.log('');

  if (!opts.yes) {
    const answer = await confirm('Continue? [y/N] ');
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Aborted.');
      process.exitCode = 1;
      return;
    }
  }

  try {
    clearHosts();
  } catch (e) {
    logger.warn(`Could not clear hosts file: ${e.message}`);
  }

  for (const project of projects) {
    if (clusterExists(project.cluster)) {
      teardownCluster(project.cluster);
    }
  }

  const detected = detectEngine();
  if (detected && detected.engine === 'podman') {
    teardownInsecureRegistry();
  }

  // Stop any background dev loops `localctl app up` left running (e.g. if `localctl app down` was
  // never run for them) before deleting their pid/log files out from under them.
  if (fs.existsSync(RUN_DIR)) {
    fs.readdirSync(RUN_DIR)
      .filter((f) => f.endsWith('.pid'))
      .forEach((f) => {
        const pid = parseInt(fs.readFileSync(path.join(RUN_DIR, f), 'utf8'), 10);
        if (Number.isFinite(pid) && isRunning(pid)) {
          logger.step(`Stopping background Tilt process for "${f.replace(/\.pid$/, '')}" (pid ${pid})...`);
          try {
            process.kill(pid, 'SIGTERM');
          } catch (e) {
            // already gone
          }
        }
      });
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  }

  const certsDir = path.join(os.homedir(), '.localctl', 'certs');
  const appsRegistry = path.join(os.homedir(), '.localctl', 'apps.json');
  if (fs.existsSync(certsDir)) fs.rmSync(certsDir, { recursive: true, force: true });
  if (fs.existsSync(appsRegistry)) fs.rmSync(appsRegistry, { force: true });
  if (fs.existsSync(PROFILES_PATH)) fs.rmSync(PROFILES_PATH, { force: true });
  logger.success('Removed ~/.localctl state (certs, app registry, project registry, background dev-loop tracking)');

  console.log();
  logger.success('Uninstall complete.');
  console.log('');
  console.log('Left in place (remove yourself if you want them gone too):');
  console.log('  brew uninstall k3d kubectl tilt mkcert node   # only if nothing else needs them');
  console.log("  mkcert -uninstall   # removes the root CA from trust stores - affects EVERY");
  console.log('                      # mkcert-issued cert on this machine, not just *.local.test');
}

module.exports = (program) => {
  program
    .command('uninstall')
    .option('-y, --yes', 'skip the confirmation prompt')
    .description('Remove everything "localctl setup"/"localctl profiles" set up: every project\'s cluster, registries, hosts entries, state')
    .action(uninstall);
};
