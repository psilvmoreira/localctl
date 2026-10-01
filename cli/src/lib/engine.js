const { commandExists, capture } = require('./exec');

// Returns { engine, bin } - `engine` names what's actually running (docker/podman/rancher-desktop),
// `bin` is the CLI to drive it with (usually the same, except Rancher Desktop, which exposes
// docker or nerdctl depending on how it's configured). Returns null if nothing usable is found.
function detectEngine() {
  if (commandExists('docker') && capture('docker', ['info']).status === 0) {
    return { engine: 'docker', bin: 'docker' };
  }
  if (commandExists('podman') && capture('podman', ['info']).status === 0) {
    return { engine: 'podman', bin: 'podman' };
  }
  if (commandExists('rdctl')) {
    if (commandExists('docker')) return { engine: 'rancher-desktop', bin: 'docker' };
    if (commandExists('nerdctl')) return { engine: 'rancher-desktop', bin: 'nerdctl' };
  }
  return null;
}

module.exports = { detectEngine };
