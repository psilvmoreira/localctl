#!/usr/bin/env node
// Verifies the *published artifact*, not the source tree: packs the tarball, installs it into a
// throwaway prefix, and runs the installed binary. Catches files missing from "files", assets the
// prepack step failed to copy, and bin/shebang problems - the class of bugs only users would see.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');

const CLI_DIR = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// Run npm through its JS entry point (set by `npm run`) rather than npm.cmd: spawning .cmd files
// needs shell: true on Windows, which concatenates args unescaped and breaks on paths with spaces.
function npm(args, opts = {}) {
  if (!process.env.npm_execpath) throw new Error('run via `npm run test:pack`');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8', ...opts });
}

// The installed .cmd shim can only be run through cmd.exe; quote it ourselves.
function runBin(bin, args) {
  if (!isWin) return execFileSync(bin, args, { encoding: 'utf8' });
  return execFileSync('cmd.exe', ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
}

const REQUIRED_FILES = [
  'bin/localctl.js',
  'src/index.js',
  'templates/Tiltfile.tmpl',
  'assets/manifests/tls-store.yaml',
  'assets/manifests/namespace-addons.yaml',
  'schema/app.schema.json',
  'src/lib/addons/postgres/addon.yaml',
  'README.md',
  'LICENSE',
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'localctl-pack-'));
try {
  const out = npm(['pack', '--json', '--pack-destination', work], { cwd: CLI_DIR });
  const [info] = JSON.parse(out.slice(out.indexOf('[')));
  const packed = new Set(info.files.map((f) => f.path));

  const missing = REQUIRED_FILES.filter((f) => !packed.has(f));
  if (missing.length) {
    console.error(`pack-test: tarball is missing:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  const tarball = path.join(work, info.filename);
  const prefix = path.join(work, 'prefix');
  npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball]);

  const bin = isWin ? path.join(prefix, 'localctl.cmd') : path.join(prefix, 'bin', 'localctl');
  const version = runBin(bin, ['--version']).trim();
  if (version !== pkg.version) {
    console.error(`pack-test: installed binary printed "${version}", expected "${pkg.version}"`);
    process.exit(1);
  }

  console.log(`pack-test: ok (${info.filename}, ${info.entryCount} files, ${(info.size / 1024).toFixed(1)} kB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
