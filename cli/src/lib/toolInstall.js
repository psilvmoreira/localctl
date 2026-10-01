const { commandExists, run } = require('./exec');
const logger = require('./logger');

// macId: Homebrew formula name. winId: winget package id.
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
    if (!commandExists('winget')) {
      throw new Error('winget is required to install missing tools (ships with modern Windows / App Installer).');
    }
    logger.step(`Installing ${bin} via winget...`);
    run('winget', [
      'install', '--id', winId, '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
    ]);
  } else {
    throw new Error(`"${bin}" is missing and automatic install isn't supported on this platform. Install it manually.`);
  }
}

module.exports = { installIfMissing };
