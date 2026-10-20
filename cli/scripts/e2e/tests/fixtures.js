// A tiny real app for the cluster tests: busybox's httpd serving one static page. No language
// runtime, no dependencies to download beyond one ~2 MB base image.
const fs = require('fs');
const path = require('path');
const { PROFILE } = require('../lib/context');

const MARKER = 'localctl-e2e-ok';

// Writes the app's files (everything except .local/config.json, which `localctl app new` makes).
function writeAppFiles(dir) {
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'www', 'index.html'), `${MARKER}\n`);
  fs.writeFileSync(path.join(dir, 'Dockerfile'), [
    'FROM docker.io/library/busybox:1.36',
    'COPY www /www',
    'EXPOSE 3000',
    'CMD ["httpd", "-f", "-v", "-p", "3000", "-h", "/www"]',
    '',
  ].join('\n'));
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.local', 'config.json'), 'utf8'));
}

function writeConfig(dir, patch) {
  const file = path.join(dir, '.local', 'config.json');
  const next = { ...readConfig(dir), ...patch };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Marks everything under `dir` as belonging to the e2e project (what `profiles new` would write).
function writeProjectFile(dir, profile = PROFILE) {
  fs.mkdirSync(path.join(dir, '.local'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.local', 'project.json'), `${JSON.stringify({ profile })}\n`);
}

module.exports = { MARKER, writeAppFiles, readConfig, writeConfig, writeProjectFile };
