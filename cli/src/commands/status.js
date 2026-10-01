const fs = require('fs');
const { isRunning } = require('../lib/exec');
const { runFiles, CONFIG_PATH } = require('../lib/paths');
const { getList, workloadsWithPrefix } = require('../lib/workloadReadiness');
const { loadConfig } = require('../lib/loadConfig');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { getActive, clusterNameFor } = require('../lib/profileStore');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

function key(obj) {
  return `${obj.metadata.namespace}/${obj.metadata.name}`;
}

function collect() {
  const deployments = getList(['get', 'deployment', '-A', '-l', 'localctl.dev/managed=true']);
  const ingresses = getList(['get', 'ingress', '-A', '-l', 'localctl.dev/managed=true']);
  const services = getList(['get', 'service', '-A', '-l', 'localctl.dev/managed=true']);
  return {
    deployments,
    ingressByKey: new Map(ingresses.map((i) => [key(i), i])),
    serviceByKey: new Map(services.map((s) => [key(s), s])),
  };
}

function devLoop(name) {
  const { pidFile } = runFiles(name);
  if (!fs.existsSync(pidFile)) return ui.dim('-');
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  if (Number.isFinite(pid) && isRunning(pid)) return ui.ok(`running (pid ${pid})`);
  return ui.warn('stopped');
}

function readyLabel(dep) {
  return ui.readyLabel(dep.status.readyReplicas || 0, dep.spec.replicas);
}

function urlFor(dep, ingressByKey) {
  const ing = ingressByKey.get(key(dep));
  const rule = ing && ing.spec.rules && ing.spec.rules[0];
  if (!rule) return ui.dim('-');
  const scheme = ing.spec.tls && ing.spec.tls.length ? 'https' : 'http';
  return ui.url(`${scheme}://${rule.host}`);
}

function debugPortFor(dep, serviceByKey) {
  const svc = serviceByKey.get(key(dep));
  const port = svc && svc.spec.ports.find((p) => p.name === 'debug');
  return port ? String(port.port) : null;
}

function dependenciesFor(dep) {
  // Real Helm charts pick whichever workload kind fits them - not every addon is a plain
  // Deployment like the app itself always is (see lib/workloadReadiness.js).
  const prefix = `${dep.metadata.name}-`;
  return workloadsWithPrefix(dep.metadata.namespace, prefix)
    .map((w) => ({ name: w.name, ready: ui.readyLabel(w.ready, w.desired) }));
}

function printSingle(dep, ingressByKey, serviceByKey) {
  const debugPort = debugPortFor(dep, serviceByKey);
  console.log(`${ui.bold(dep.metadata.name)}`);
  console.log(`  namespace: ${dep.metadata.namespace}`);
  console.log(`  ready:     ${readyLabel(dep)}`);
  console.log(`  url:       ${urlFor(dep, ingressByKey)}`);
  if (debugPort) console.log(`  debug:     localhost:${debugPort}`);
  console.log(`  dev loop:  ${devLoop(dep.metadata.name)}`);

  const deps = dependenciesFor(dep);
  if (deps.length > 0) {
    console.log('  dependencies:');
    deps.forEach((d) => console.log(`    ${d.name}  ${d.ready}`));
  }
}

function printAll(deployments, ingressByKey, serviceByKey) {
  const rows = deployments.map((dep) => [
    dep.metadata.name,
    dep.metadata.namespace,
    readyLabel(dep),
    urlFor(dep, ingressByKey),
    devLoop(dep.metadata.name),
  ]);
  ui.printTable(['APP', 'NAMESPACE', 'READY', 'URL', 'DEV LOOP'], rows);

  if (!deployments.some((dep) => devLoop(dep.metadata.name).includes('running'))) {
    console.log('');
    logger.info('Dev loop not running locally for any app - "localctl app up" from an app\'s directory to start one.');
  }
}

module.exports = (program) => {
  program
    .command('status')
    .option('-a, --app <name>', 'show status for one app by name, in the currently active project\'s cluster')
    .option('-A, --all', 'show every app in the currently active project\'s cluster, even from inside an app repo')
    .description('Show every localctl-managed app in a cluster: readiness, URL, local dev-loop state')
    .action((opts) => {
      let targetName = opts.app;
      let targetNamespace = null;

      // Directory-resolved single-app view: figures out which project (and so which cluster and
      // namespace/subdomain prefix) this app belongs to on its own - see loadConfig.js.
      if (!targetName && !opts.all && fs.existsSync(CONFIG_PATH)) {
        const cfg = loadConfig();
        ensureClusterUp(cfg.clusterName, cfg.profile);
        targetName = cfg.name;
        targetNamespace = cfg.namespace;
      } else {
        // No directory context (elsewhere, -a, or -A): fall back to whichever project is
        // currently active (see "localctl profiles switch").
        const active = getActive();
        ensureClusterUp(clusterNameFor(active), active);
      }

      const { deployments, ingressByKey, serviceByKey } = collect();
      if (deployments.length === 0) {
        logger.info('No localctl-managed apps found in the cluster.');
        return;
      }

      if (targetName) {
        const dep = deployments.find(
          (d) => d.metadata.name === targetName && (!targetNamespace || d.metadata.namespace === targetNamespace),
        );
        if (!dep) {
          logger.warn(`No deployed app named "${targetName}" found in the cluster.`);
          return;
        }
        printSingle(dep, ingressByKey, serviceByKey);
        return;
      }

      printAll(deployments, ingressByKey, serviceByKey);
    });
};
