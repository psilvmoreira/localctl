const { commandExists, capture } = require('./exec');
const logger = require('./logger');

// Support status per engine lives in cli/package.json ("localctl.containerEngines"), so marking an
// engine as tested is a one-word config change, not a code change. "tested" means verified end to
// end; anything else (or an engine missing from the map) gets the experimental warning.
const { localctl: { containerEngines = {}, platforms = {} } = {} } = require('../../package.json');
const ENGINE_LABELS = { docker: 'Docker', podman: 'Podman', 'rancher-desktop': 'Rancher Desktop' };
const ISSUES_URL = 'https://github.com/psilvmoreira/localctl/issues';

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

function warnIfExperimental(engine) {
  if (containerEngines[engine] === 'tested') return;
  const tested = Object.keys(containerEngines).filter((e) => containerEngines[e] === 'tested');
  const testedList = tested.map((e) => ENGINE_LABELS[e] || e).join(', ') || 'none';
  logger.warn(`${ENGINE_LABELS[engine] || engine} support is experimental - fully tested so far: ${testedList}.`);
  logger.warn(`If something breaks, please report it: ${ISSUES_URL}`);
}

const PLATFORM_LABELS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

// Same idea as warnIfExperimental(), for the operating system: platform status lives in
// cli/package.json ("localctl.platforms").
function warnIfExperimentalPlatform() {
  if (!platforms[process.platform] || platforms[process.platform] === 'tested') return;
  logger.warn(`${PLATFORM_LABELS[process.platform] || process.platform} support is experimental - it hasn't been through a full test cycle yet.`);
  logger.warn(`If something breaks, please report it: ${ISSUES_URL}`);
}

module.exports = { detectEngine, warnIfExperimental, warnIfExperimentalPlatform };
