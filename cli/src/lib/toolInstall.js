const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandExists, run, capture } = require('./exec');
const logger = require('./logger');
const { detectDistro } = require('./linuxDistro');
const { HOME_STATE_DIR } = require('./paths');

// Tools that have no package-manager package on a platform get downloaded here instead. The
// directory is added to the user's PATH for new terminals, and to this process's PATH by
// addToolsDirToPath() on every run, so the current terminal needs no restart.
const TOOLS_DIR = path.join(HOME_STATE_DIR, 'tools');

function prependToPath(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = (process.env.PATH || '').split(path.delimiter);
  if (!entries.includes(dir)) process.env.PATH = [dir, ...entries].join(path.delimiter);
}

function addToolsDirToPath() {
  prependToPath(TOOLS_DIR);
}

// winget puts portable packages (k3d, kubectl, helm, mkcert) behind links in this directory and
// adds it to PATH for new terminals only. Adding it here lets the rest of `localctl setup` use a
// tool winget just installed.
function addWingetLinksToPath() {
  if (process.env.LOCALAPPDATA) prependToPath(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
}

function powershell(script) {
  run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

// Tilt isn't published to winget. Same steps as Tilt's own install.ps1 (latest release zip from
// GitHub), but into TOOLS_DIR and with the directory added to the user's PATH, which install.ps1
// leaves to you.
function installTiltWindows() {
  logger.step('Installing tilt from its GitHub release (not available on winget)...');
  powershell(`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $dir = '${TOOLS_DIR.replace(/'/g, "''")}'
    $version = (Invoke-RestMethod 'https://api.github.com/repos/tilt-dev/tilt/releases/latest').tag_name.TrimStart('v')
    $url = "https://github.com/tilt-dev/tilt/releases/download/v$version/tilt.$version.windows.x86_64.zip"
    $tmp = Join-Path $env:TEMP "localctl-tilt-$version"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory -Force -Path $tmp, $dir | Out-Null
    Write-Host "Downloading $url"
    Invoke-WebRequest $url -OutFile "$tmp\\tilt.zip"
    Expand-Archive "$tmp\\tilt.zip" -DestinationPath $tmp
    Move-Item -Force "$tmp\\tilt.exe" "$dir\\tilt.exe"
    Remove-Item -Recurse -Force $tmp
    # Raw registry value, so entries like %USERPROFILE%\\bin stay unexpanded (REG_EXPAND_SZ).
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if ((($userPath -split ';') | Where-Object { $_ -eq $dir }).Count -eq 0) {
      $key.SetValue('Path', (($userPath.TrimEnd(';'), $dir) -join ';').TrimStart(';'), 'ExpandString')
      # Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so terminals opened
      # from now on pick up the new PATH without signing out.
      [Environment]::SetEnvironmentVariable('LOCALCTL_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('LOCALCTL_PATH_REFRESH', $null, 'User')
    }
    $key.Close()
  `);
  addToolsDirToPath();
  logger.success(`tilt installed in ${TOOLS_DIR} (added to your PATH for new terminals)`);
}


// ---- Linux ----
// There's no single package manager to lean on across distros, so missing tools are fetched as
// the vendors' own release binaries straight into TOOLS_DIR (no sudo, no distro packages). That
// directory is on this process's PATH via addToolsDirToPath(), so setup carries on immediately.
// Needs only curl (and tar for tilt/helm), which every mainstream distro ships.

const LINUX_ARCH = { x64: 'amd64', arm64: 'arm64' };

function linuxArch() {
  const arch = LINUX_ARCH[process.arch];
  if (!arch) throw new Error(`Unsupported CPU architecture "${process.arch}". Install the tool manually.`);
  return arch;
}

function requireLinuxDownloadTools(...tools) {
  const missing = tools.filter((t) => !commandExists(t));
  if (missing.length) {
    throw new Error(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} needed to download missing tools. Install ${missing.length > 1 ? 'them' : 'it'} with your package manager and re-run.`);
  }
}

function download(url, dest) {
  logger.info(`Downloading ${url}`);
  run('curl', ['-fsSL', '--retry', '3', '-o', dest, url]);
}

// Final path segment of the URL a redirect lands on, e.g. ".../releases/tag/v0.33.0" -> "v0.33.0".
function latestGitHubTag(repo) {
  const res = capture('curl', [
    '-fsSLI', '-o', '/dev/null', '-w', '%{url_effective}',
    `https://github.com/${repo}/releases/latest`,
  ]);
  const tag = res.stdout.split('/').pop();
  if (res.status !== 0 || !/^v?\d/.test(tag)) throw new Error(`Couldn't resolve the latest ${repo} release.`);
  return tag;
}

function makeExecutable(file) {
  fs.chmodSync(file, 0o755);
}

function installBinaryLinux(bin, url) {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const dest = path.join(TOOLS_DIR, bin);
  download(url, dest);
  makeExecutable(dest);
}

// Downloads a .tar.gz and moves one file out of it into TOOLS_DIR.
function installFromTarballLinux(bin, url, innerPath) {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `localctl-${bin}-`));
  try {
    const archive = path.join(tmp, 'archive.tar.gz');
    download(url, archive);
    run('tar', ['-xzf', archive, '-C', tmp]);
    const dest = path.join(TOOLS_DIR, bin);
    fs.copyFileSync(path.join(tmp, innerPath), dest);
    makeExecutable(dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const LINUX_INSTALLERS = {
  k3d() {
    installBinaryLinux('k3d', `https://github.com/k3d-io/k3d/releases/latest/download/k3d-linux-${linuxArch()}`);
  },
  kubectl() {
    const version = capture('curl', ['-fsSL', 'https://dl.k8s.io/release/stable.txt']).stdout;
    if (!/^v\d/.test(version)) throw new Error("Couldn't resolve the latest kubectl release.");
    installBinaryLinux('kubectl', `https://dl.k8s.io/release/${version}/bin/linux/${linuxArch()}/kubectl`);
  },
  mkcert() {
    installBinaryLinux('mkcert', `https://dl.filippo.io/mkcert/latest?for=linux/${linuxArch()}`);
  },
  helm() {
    const version = capture('curl', ['-fsSL', 'https://get.helm.sh/helm-latest-version']).stdout;
    if (!/^v\d/.test(version)) throw new Error("Couldn't resolve the latest helm release.");
    const arch = linuxArch();
    installFromTarballLinux('helm', `https://get.helm.sh/helm-${version}-linux-${arch}.tar.gz`, `linux-${arch}/helm`);
  },
  tilt() {
    const version = latestGitHubTag('tilt-dev/tilt').replace(/^v/, '');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    installFromTarballLinux('tilt', `https://github.com/tilt-dev/tilt/releases/download/v${version}/tilt.${version}.linux.${arch}.tar.gz`, 'tilt');
  },
};

// Tools land in TOOLS_DIR, which localctl puts on its own PATH, but a terminal opened later (to
// run `kubectl` by hand, say) wouldn't see them. Persist it in the shell's rc file, with the same
// marker bin/bootstrap.sh uses so bin/uninstall.sh cleans it up. bash and zsh only: other shells
// get the line to add themselves.
function persistToolsDirOnPath() {
  const shell = path.basename(process.env.SHELL || '');
  const rcName = { zsh: '.zshrc', bash: '.bashrc' }[shell];
  const line = 'export PATH="$HOME/.localctl/tools:$PATH"';
  if (!rcName) {
    logger.info(`Add ${TOOLS_DIR} to your PATH to use these tools from your own terminal: ${line}`);
    return;
  }
  const rc = path.join(os.homedir(), rcName);
  const current = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  if (current.includes('.localctl/tools')) return;
  fs.appendFileSync(rc, `\n# Added by localctl bootstrap\n${line}\n`);
  logger.info(`Added ${TOOLS_DIR} to PATH in ~/${rcName} - open a new terminal to pick it up.`);
}

function installLinux(bin) {
  const installer = LINUX_INSTALLERS[bin];
  if (!installer) {
    throw new Error(`"${bin}" is missing and automatic install isn't supported for it on Linux. Install it with your package manager.`);
  }
  requireLinuxDownloadTools('curl', ...(bin === 'helm' || bin === 'tilt' ? ['tar'] : []));
  logger.step(`Installing ${bin} from its official release (no sudo, into ${TOOLS_DIR})...`);
  installer();
  addToolsDirToPath();
  persistToolsDirOnPath();
  logger.success(`${bin} installed in ${TOOLS_DIR}`);
}

// Distro-specific command for the NSS tools (certutil), which mkcert needs to trust its CA in
// Firefox/Chromium. Not installed automatically: it needs sudo, and it's optional.
function nssInstallHint() {
  const { family } = detectDistro();
  return {
    debian: 'sudo apt install libnss3-tools',
    rhel: 'sudo dnf install nss-tools',
    arch: 'sudo pacman -S nss',
    suse: 'sudo zypper install mozilla-nss-tools',
    alpine: 'sudo apk add nss-tools',
  }[family] || "your distro's NSS tools package (provides certutil)";
}

// macId: Homebrew formula name. winId: winget package id, or a function that installs the tool
// when winget doesn't have it.
function installIfMissing(bin, macId, winId) {
  if (commandExists(bin)) {
    logger.success(`${bin} already installed`);
    return;
  }
  if (process.platform === 'darwin') {
    if (!commandExists('brew')) {
      throw new Error('Homebrew is required to install missing tools. Install from https://brew.sh and re-run.');
    }
    logger.step(`Installing ${macId} via brew...`);
    run('brew', ['install', macId]);
  } else if (process.platform === 'win32') {
    if (typeof winId === 'function') {
      winId();
      return;
    }
    if (!commandExists('winget')) {
      throw new Error('winget is required to install missing tools (ships with modern Windows / App Installer).');
    }
    logger.step(`Installing ${bin} via winget...`);
    run('winget', [
      'install', '--id', winId, '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
    ]);
    addWingetLinksToPath();
  } else if (process.platform === 'linux') {
    installLinux(bin);
  } else {
    throw new Error(`"${bin}" is missing and automatic install isn't supported on this platform. Install it manually.`);
  }
}

module.exports = { installIfMissing, installTiltWindows, addToolsDirToPath, nssInstallHint, TOOLS_DIR };
