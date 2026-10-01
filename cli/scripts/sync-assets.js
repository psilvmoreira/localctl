#!/usr/bin/env node
// Copies the repo-root files the CLI needs at runtime into cli/ so they ship inside the npm
// tarball. Runs automatically on `npm pack`/`npm publish` (prepack). The repo-root copies stay the
// single source of truth - the copies under cli/ are build output and are git-ignored.
const fs = require('fs');
const path = require('path');

const CLI_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CLI_DIR, '..');

const COPIES = [
  { from: path.join(REPO_ROOT, 'cluster', 'manifests'), to: path.join(CLI_DIR, 'assets', 'manifests') },
  { from: path.join(REPO_ROOT, 'schema'), to: path.join(CLI_DIR, 'schema') },
  { from: path.join(REPO_ROOT, 'README.md'), to: path.join(CLI_DIR, 'README.md') },
  { from: path.join(REPO_ROOT, 'LICENSE'), to: path.join(CLI_DIR, 'LICENSE') },
];

for (const { from, to, optional } of COPIES) {
  if (!fs.existsSync(from)) {
    if (optional) continue;
    console.error(`sync-assets: missing required source ${path.relative(REPO_ROOT, from)}`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`sync-assets: ${path.relative(REPO_ROOT, from)} -> ${path.relative(REPO_ROOT, to)}`);
}
