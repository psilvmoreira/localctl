const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('./logger');
const { ensureHomeState, APPS_REGISTRY_PATH } = require('./paths');
const { DOMAIN } = require('./constants');

const MARK_START = '# >>> localctl managed block >>>';
const MARK_END = '# <<< localctl managed block <<<';
const HOSTS_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';

function registerApp(subdomain) {
  ensureHomeState();
  const registry = JSON.parse(fs.readFileSync(APPS_REGISTRY_PATH, 'utf8'));
  registry[subdomain] = true;
  fs.writeFileSync(APPS_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function listApps() {
  ensureHomeState();
  const registry = JSON.parse(fs.readFileSync(APPS_REGISTRY_PATH, 'utf8'));
  return Object.keys(registry);
}

// The Windows counterpart of `sudo cp`: copies src over the hosts file from an elevated
// PowerShell, which raises a UAC prompt. Returns false if the prompt is declined or the copy
// fails. The inner command goes through -EncodedCommand so paths need no nested quoting.
function copyElevatedWindows(src) {
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  const inner = `Copy-Item -LiteralPath ${quote(src)} -Destination ${quote(HOSTS_PATH)} -Force`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const res = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
  ], { stdio: 'ignore' });
  return res.status === 0;
}

function writeHosts(next, current) {
  if (next === current) {
    logger.info('Hosts file already up to date.');
    return;
  }

  try {
    fs.writeFileSync(HOSTS_PATH, next);
    logger.success(`Updated ${HOSTS_PATH}`);
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    const tmp = path.join(os.tmpdir(), 'localctl-hosts-new');
    fs.writeFileSync(tmp, next);
    if (process.platform === 'win32') {
      logger.warn('Need Administrator rights to update the hosts file. Approve the Windows prompt to continue.');
      if (copyElevatedWindows(tmp) && fs.readFileSync(HOSTS_PATH, 'utf8') === next) {
        logger.success(`Updated ${HOSTS_PATH}`);
      } else {
        logger.warn('Hosts file not updated, so *.local.test addresses won\'t resolve. Run in an elevated PowerShell:');
        console.log(`  Copy-Item "${tmp}" "${HOSTS_PATH}" -Force`);
      }
    } else {
      logger.warn('Need sudo to update the hosts file.');
      const res = spawnSync('sudo', ['cp', tmp, HOSTS_PATH], { stdio: 'inherit' });
      if (res.status === 0) logger.success(`Updated ${HOSTS_PATH}`);
      else logger.warn(`Run manually: sudo cp ${tmp} ${HOSTS_PATH}`);
    }
  }
}

function syncHosts() {
  const apps = listApps();
  const lines = [
    MARK_START,
    ...apps.map((s) => `127.0.0.1 ${s}.${DOMAIN}`),
    `127.0.0.1 ${DOMAIN}`,
    MARK_END,
  ];
  const block = lines.join(os.EOL);

  const current = fs.readFileSync(HOSTS_PATH, 'utf8');
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`, 'm');
  const next = re.test(current)
    ? current.replace(re, block)
    : `${current.trimEnd()}${os.EOL}${block}${os.EOL}`;

  writeHosts(next, current);
}

// Used by uninstall: strips the whole managed block, leaving the rest of the hosts file alone.
function clearHosts() {
  const current = fs.readFileSync(HOSTS_PATH, 'utf8');
  const re = new RegExp(`(${os.EOL}|\\n)?${MARK_START}[\\s\\S]*?${MARK_END}(${os.EOL}|\\n)?`, 'm');
  const next = current.replace(re, os.EOL);
  writeHosts(next, current);
}

module.exports = { syncHosts, clearHosts, registerApp, listApps };
