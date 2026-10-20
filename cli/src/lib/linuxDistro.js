const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, commandExists } = require('./exec');
const logger = require('./logger');

// Families localctl knows how to give exact commands for. Anything else is "unknown" and gets
// generic guidance instead of a guess.
const FAMILY_BY_ID = [
  ['debian', ['debian', 'ubuntu']],
  ['rhel', ['fedora', 'rhel', 'centos', 'rocky', 'almalinux']],
  ['arch', ['arch']],
  ['suse', ['suse', 'opensuse']],
  ['alpine', ['alpine']],
];

// Reads ID and ID_LIKE from os-release, so derivatives resolve to their parent (Mint, Pop!_OS ->
// debian; Rocky, Alma -> rhel; Manjaro -> arch).
function detectDistro() {
  let release = null;
  // /usr/lib/os-release is the documented fallback when /etc/os-release is missing.
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      release = fs.readFileSync(file, 'utf8');
      break;
    } catch (e) {
      // try the next location
    }
  }
  if (release === null) return { id: 'unknown', family: 'unknown' };
  const value = (key) => {
    const m = release.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].replace(/"/g, '').trim() : '';
  };
  const id = value('ID') || 'unknown';
  const ids = [id, ...value('ID_LIKE').split(/\s+/)].filter(Boolean);
  const match = FAMILY_BY_ID.find(([, names]) => names.some((n) => ids.includes(n)));
  return { id, family: match ? match[0] : 'unknown' };
}

function hasSystemd() {
  return fs.existsSync('/run/systemd/system');
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// What `localctl setup --install-docker` would do, as printable steps. Shown in the "no engine"
// error too, so the user can run them by hand. Returns null for families without a known recipe.
function dockerInstallSteps(family, id) {
  const sudo = isRoot() ? '' : 'sudo ';
  const user = os.userInfo().username;
  let install;
  if (family === 'rhel' && id !== 'fedora') {
    // Docker's convenience script derives the repo path from the distro ID, and publishes
    // .../linux/centos and .../linux/rhel but not .../linux/rocky or .../linux/almalinux: it adds
    // a repo whose packages don't exist ("Unable to find a match: docker-ce"). The CentOS repo is
    // what Docker documents for the RHEL rebuilds.
    install = [
      `${sudo}dnf -y install dnf-plugins-core`,
      `${sudo}dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo`,
      `${sudo}dnf -y install docker-ce docker-ce-cli containerd.io`,
    ];
  } else if (family === 'debian' || family === 'rhel') {
    install = [`curl -fsSL https://get.docker.com -o get-docker.sh && ${sudo}sh get-docker.sh`];
  } else if (family === 'arch') {
    install = [`${sudo}pacman -S --noconfirm docker`];
  } else if (family === 'suse') {
    install = [`${sudo}zypper --non-interactive install docker`];
  } else {
    return null;
  }
  const steps = [...install];
  if (hasSystemd()) steps.push(`${sudo}systemctl enable --now docker`);
  if (!isRoot()) steps.push(`${sudo}usermod -aG docker ${user}`);
  return steps;
}

// Runs dockerInstallSteps() for real. The download goes to a temp file first (never piped into a
// shell) and Docker's official script is the only remote code involved. Needs sudo, so it only
// ever runs on an explicit `--install-docker`.
function installDocker() {
  const { family, id } = detectDistro();
  if (!dockerInstallSteps(family, id)) {
    throw new Error(`No automatic Docker install for "${id}". Install Docker Engine for your distro (https://docs.docker.com/engine/install/) and re-run.`);
  }
  const viaScript = family === 'debian' || (family === 'rhel' && id === 'fedora');
  if (!commandExists('curl') && viaScript) {
    throw new Error('curl is needed to download the Docker install script. Install it and re-run.');
  }
  logger.step(`Installing Docker Engine (${id}). This needs sudo and will prompt for your password...`);
  const sudo = isRoot() ? [] : ['sudo'];
  const exec = (cmd, args) => run(sudo.length ? sudo[0] : cmd, sudo.length ? [cmd, ...args] : args);

  if (viaScript) {
    const script = path.join(os.tmpdir(), 'localctl-get-docker.sh');
    run('curl', ['-fsSL', 'https://get.docker.com', '-o', script]);
    try {
      exec('sh', [script]);
    } finally {
      fs.rmSync(script, { force: true });
    }
  } else if (family === 'rhel') {
    exec('dnf', ['-y', 'install', 'dnf-plugins-core']);
    exec('dnf', ['config-manager', '--add-repo', 'https://download.docker.com/linux/centos/docker-ce.repo']);
    exec('dnf', ['-y', 'install', 'docker-ce', 'docker-ce-cli', 'containerd.io']);
  } else if (family === 'arch') {
    exec('pacman', ['-S', '--noconfirm', 'docker']);
  } else if (family === 'suse') {
    exec('zypper', ['--non-interactive', 'install', 'docker']);
  }
  if (hasSystemd()) exec('systemctl', ['enable', '--now', 'docker']);
  if (!isRoot()) exec('usermod', ['-aG', 'docker', os.userInfo().username]);

  logger.success('Docker installed.');
  if (!isRoot()) {
    logger.warn('Group membership only applies to new sessions: log out and back in (or run "newgrp docker"), then re-run "localctl setup".');
  }
}

module.exports = { detectDistro, hasSystemd, dockerInstallSteps, installDocker };
