const fs = require('fs');
const path = require('path');
const { commandExists, run } = require('./exec');
const logger = require('./logger');
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
  } else {
    throw new Error(`"${bin}" is missing and automatic install isn't supported on this platform. Install it manually.`);
  }
}

module.exports = { installIfMissing, installTiltWindows, addToolsDirToPath, TOOLS_DIR };
