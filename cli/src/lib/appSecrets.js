const { run, capture } = require('./exec');

// One Secret per app, holding whatever keys `.local/config.json`'s "secrets" array declares.
// Unlike addon-generated secrets (random values, never seen by you), these are values *you*
// supply - an API key, a third-party token - so there's no "generate once" step: you set them
// with `localctl app secrets set`, and manifestGen.js just references them via secretKeyRef.
function secretNameFor(cfg) {
  return `${cfg.name}-secrets`;
}

function ensureNamespace(namespace) {
  if (capture('kubectl', ['get', 'namespace', namespace]).status !== 0) {
    run('kubectl', ['create', 'namespace', namespace], { stdio: 'ignore', allowFail: true });
  }
}

function readAll(cfg) {
  const res = capture('kubectl', ['get', 'secret', secretNameFor(cfg), '-n', cfg.namespace, '-o', 'json']);
  if (res.status !== 0) return {};
  const data = JSON.parse(res.stdout).data || {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
}

// Rewrites the whole Secret from a plain key->value map. `apply` (not `create`) makes this
// idempotent - a re-run with the same data is a no-op, a changed one updates in place.
function writeAll(cfg, data) {
  ensureNamespace(cfg.namespace);
  const doc = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretNameFor(cfg), namespace: cfg.namespace },
    type: 'Opaque',
    stringData: data,
  };
  run('kubectl', ['apply', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'], input: JSON.stringify(doc) });
}

function setSecret(cfg, key, value) {
  const data = readAll(cfg);
  data[key] = value;
  writeAll(cfg, data);
}

function unsetSecret(cfg, key) {
  const data = readAll(cfg);
  if (!(key in data)) return false;
  delete data[key];
  if (Object.keys(data).length === 0) {
    run('kubectl', ['delete', 'secret', secretNameFor(cfg), '-n', cfg.namespace, '--ignore-not-found=true'], { stdio: 'ignore' });
  } else {
    writeAll(cfg, data);
  }
  return true;
}

function listKeys(cfg) {
  return Object.keys(readAll(cfg));
}

module.exports = { secretNameFor, setSecret, unsetSecret, listKeys, readAll };
