#!/usr/bin/env node
// Fast sanity check run in CI and before every publish: every command module loads and the CLI
// answers --version/--help. Catches broken requires and syntax errors without needing a cluster.
const { execFileSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const BIN = path.resolve(__dirname, '..', 'bin', 'localctl.js');

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }).trim();
}

const version = run(['--version']);
if (version !== pkg.version) {
  console.error(`smoke-test: --version printed "${version}", package.json says "${pkg.version}"`);
  process.exit(1);
}

for (const args of [['--help'], ['app', '--help'], ['profiles', '--help'], ['addons', '--help']]) {
  run(args);
}

console.log(`smoke-test: ok (localctl ${version})`);
