// Everything a test needs to run the CLI against a throwaway world: its own state directory,
// hosts file and kubeconfig, so nothing in your real ~/.localctl, /etc/hosts or ~/.kube is read
// or written. Also builds the env the CLI (and the Tilt it spawns) runs with.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_DIR = path.resolve(__dirname, '..', '..', '..');
const BIN = path.join(CLI_DIR, 'bin', 'localctl.js');

// Fixed names so a crashed run's leftovers can be found and removed safely. localctl never
// generates a name starting with "localctl-e2e" (its own are local-dev or local-dev-<project>),
// so removing by this exact name cannot hit one of your clusters.
const PROFILE = 'e2e';
const CLUSTER = 'localctl-e2e';
const DEFAULT_PROFILE_CLUSTER = 'localctl-e2e-default'; // the isolated "default" project: never exists
const REGISTRY_PORT = 5099; // fixed: Podman trusts a registry port per machine, so a new random port every run would restart the VM every run

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localctl-e2e-'));
  const ws = {
    root,
    home: path.join(root, 'home'),
    hostsFile: path.join(root, 'hosts'),
    kubeconfig: path.join(root, 'kubeconfig'),
    shimDir: path.join(root, 'bin'),
    apps: path.join(root, 'apps'),
  };
  [ws.home, ws.shimDir, ws.apps].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  fs.writeFileSync(ws.hostsFile, '127.0.0.1 localhost\n# e2e: this line must survive hosts sync/clear\n');
  fs.writeFileSync(ws.kubeconfig, '');

  // Tilt (and the generated Tiltfile) call plain `localctl`, so the one under test must be first
  // on PATH - not whatever happens to be installed globally.
  const shim = path.join(ws.shimDir, 'localctl');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return ws;
}

function envFor(ws, extra = {}) {
  return {
    ...process.env,
    LOCALCTL_HOME: ws.home,
    LOCALCTL_HOSTS_FILE: ws.hostsFile,
    LOCALCTL_NO_UPDATE_CHECK: '1',
    KUBECONFIG: ws.kubeconfig,
    PATH: `${ws.shimDir}${path.delimiter}${process.env.PATH}`,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  };
}

// profiles.json for the throwaway world. "default" is renamed to a cluster that can't exist, so
// no command run by a test can ever resolve to (or tear down) your real `local-dev` cluster.
function seedProfiles(ws, ports) {
  const registry = {
    active: PROFILE,
    profiles: {
      default: { isolation: 'cluster', cluster: DEFAULT_PROFILE_CLUSTER, exclusive: false, ...ports },
      [PROFILE]: { isolation: 'cluster', cluster: CLUSTER, exclusive: false, ...ports },
    },
  };
  fs.writeFileSync(path.join(ws.home, 'profiles.json'), JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(ws.home, 'apps.json'), '{}');
}

module.exports = {
  CLI_DIR, BIN, PROFILE, CLUSTER, DEFAULT_PROFILE_CLUSTER, REGISTRY_PORT,
  createWorkspace, envFor, seedProfiles,
};
