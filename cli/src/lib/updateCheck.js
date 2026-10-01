// Tells the user when a newer @localctl/cli is on npm. Never slows a command down: the notice is
// printed from a cached result, and the cache is refreshed (at most once a day) by a detached
// background process that outlives this one. Silent in CI, when stderr isn't a terminal, when
// running from a source checkout, or with LOCALCTL_NO_UPDATE_CHECK=1.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('chalk');
const { HOME_STATE_DIR } = require('./paths');

const PACKAGE_NAME = '@localctl/cli';
const CACHE_PATH = path.join(HOME_STATE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEV_VERSION = '0.0.0-development';

function parse(version) {
  const [core, pre] = String(version).split('-');
  return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
}

// Plain x.y.z comparison; a pre-release is older than the same x.y.z without one. Good enough to
// decide "is there something newer" without pulling in a semver dependency.
function isNewer(candidate, current) {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function enabled(currentVersion) {
  return !process.env.LOCALCTL_NO_UPDATE_CHECK
    && !process.env.CI
    && process.stderr.isTTY
    && currentVersion !== DEV_VERSION;
}

function start(currentVersion) {
  if (!enabled(currentVersion)) return;
  const cache = readCache();

  // Users on a pre-release also get told about newer pre-releases on their own channel.
  const { pre } = parse(currentVersion);
  const channel = pre ? pre.split('.')[0] : null;
  const candidates = [cache.distTags?.latest, channel && cache.distTags?.[channel]].filter(Boolean);
  const newest = candidates.filter((v) => isNewer(v, currentVersion))
    .sort((x, y) => (isNewer(x, y) ? -1 : 1))[0];

  if (newest) {
    const tag = newest.includes('-') ? `@${channel}` : '';
    process.on('exit', () => {
      console.error();
      console.error(`${chalk.yellow('Update available:')} ${currentVersion} -> ${chalk.green(newest)}`);
      console.error(`Run ${chalk.cyan(`npm install -g ${PACKAGE_NAME}${tag}`)} to update.`);
    });
  }

  if (!cache.checkedAt || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'updateCheckWorker.js'), CACHE_PATH, PACKAGE_NAME], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch {
      // Best effort - a failed check must never affect the command the user actually ran.
    }
  }
}

module.exports = { start, isNewer };
