const path = require('path');
const os = require('os');
const fs = require('fs');

const APP_DIR = process.cwd();
const LOCAL_DIR = path.join(APP_DIR, '.local');
const CONFIG_PATH = path.join(LOCAL_DIR, 'config.json');
const HOME_STATE_DIR = path.join(os.homedir(), '.localctl');
const APPS_REGISTRY_PATH = path.join(HOME_STATE_DIR, 'apps.json');
const PROFILES_PATH = path.join(HOME_STATE_DIR, 'profiles.json');
const RUN_DIR = path.join(HOME_STATE_DIR, 'run');

function ensureHomeState() {
  if (!fs.existsSync(HOME_STATE_DIR)) fs.mkdirSync(HOME_STATE_DIR, { recursive: true });
  if (!fs.existsSync(APPS_REGISTRY_PATH)) fs.writeFileSync(APPS_REGISTRY_PATH, '{}');
}

// One {pidFile, portFile, logFile} set per app name, used by `localctl up` (detached mode),
// `localctl down`, and `localctl reload` to track/clean up/talk to a background Tilt process.
// portFile holds the random port that app's Tilt instance's web/API server is bound to (each app
// gets its own - see up.js/getFreePort), needed to address it with `tilt trigger --port <n>`.
function runFiles(name) {
  if (!fs.existsSync(RUN_DIR)) fs.mkdirSync(RUN_DIR, { recursive: true });
  return {
    pidFile: path.join(RUN_DIR, `${name}.pid`),
    portFile: path.join(RUN_DIR, `${name}.port`),
    logFile: path.join(RUN_DIR, `${name}.log`),
  };
}

module.exports = {
  APP_DIR,
  LOCAL_DIR,
  CONFIG_PATH,
  HOME_STATE_DIR,
  APPS_REGISTRY_PATH,
  PROFILES_PATH,
  RUN_DIR,
  ensureHomeState,
  runFiles,
};
