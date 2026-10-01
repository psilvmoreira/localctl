const { run } = require('./exec');
const { loadAddon } = require('./addonLoader');
const { findAddonDir, listAddonNames } = require('./addonDirs');
const { getList, workloadsWithPrefix } = require('./workloadReadiness');
const { DOMAIN, OBSERVABILITY_NAMESPACE } = require('./constants');
const ui = require('./ui');

// Cluster-wide addons live at <addons-dir>/cluster/<name>/addon.yaml - your own addons dir
// (~/.localctl/addons, or $LOCALCTL_ADDONS_DIR) is searched before the ones bundled with this
// CLI, and a name there overrides a built-in one of the same name. See docs/adding-tools.md.
// Shared by `localctl addons` and `localctl profiles new`'s "carry over which addons?" wizard.
function addonDirFor(name) {
  const dir = findAddonDir(name, 'cluster');
  if (!dir) {
    throw new Error(`Unknown addon "${name}". Known: ${listAddonNames('cluster').join(', ')}.`);
  }
  return dir;
}

function renderClusterAddon(name) {
  const { manifestYaml } = loadAddon(addonDirFor(name), {
    release: name,
    namespace: OBSERVABILITY_NAMESPACE,
    addonName: name,
    extraVars: { domain: DOMAIN },
  });
  return manifestYaml;
}

function enableClusterAddon(name) {
  run('kubectl', ['apply', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'], input: renderClusterAddon(name) });
}

function disableClusterAddon(name) {
  run('kubectl', ['delete', '-f', '-', '--ignore-not-found=true'], { stdio: ['pipe', 'inherit', 'inherit'], input: renderClusterAddon(name) });
}

function readyLabel(workloads) {
  if (workloads.length === 0) return ui.dim('-');
  const ready = workloads.reduce((sum, w) => sum + w.ready, 0);
  const desired = workloads.reduce((sum, w) => sum + w.desired, 0);
  return ui.readyLabel(ready, desired);
}

function clusterAddonInstances() {
  const records = getList(['get', 'configmap', '-A', '-l', 'localctl.dev/addon=true']);
  return records.map((r) => {
    const release = r.metadata.name.replace(/-localctl-addon$/, '');
    return {
      release,
      owner: r.data.owner || null,
      namespace: r.metadata.namespace,
      chart: `${r.data.chart}@${r.data.version}`,
      ready: readyLabel(workloadsWithPrefix(r.metadata.namespace, release)),
    };
  });
}

module.exports = { renderClusterAddon, enableClusterAddon, disableClusterAddon, clusterAddonInstances };
