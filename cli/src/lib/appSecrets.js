const { run, capture, sleepSync } = require('./exec');
const { isNotFound, isConflict, firstLine } = require('./kubeErrors');

// One Secret per app, holding whatever keys `.local/config.yaml`'s "secrets" array declares.
// Unlike addon-generated secrets (random values, never seen by you), these are values *you*
// supply - an API key, a third-party token - so there's no "generate once" step: you set them
// with `localctl app secrets set`, and manifestGen.js just references them via secretKeyRef.
function secretNameFor(cfg) {
  return `${cfg.name}-secrets`;
}

const { ensureManagedNamespace: ensureNamespace, assertNamespaceOwnership, MANAGED_LABEL } = require('./namespaces');

const MAX_VALUE_BYTES = 512 * 1024; // a Secret is limited to 1 MiB in total
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

// The Secret as stored, with what is needed to write it back safely: its data (key -> base64, kept
// in base64 end to end so binary values survive), its resourceVersion, and its labels/annotations.
// Anything unexpected in the answer is an error: a wrong guess here would overwrite real data.
function readSecret(cfg) {
  assertNamespaceOwnership(cfg);
  const name = secretNameFor(cfg);
  const res = capture('kubectl', ['get', 'secret', name, '-n', cfg.namespace, '-o', 'json', '--request-timeout=20s']);
  if (res.status !== 0) {
    if (isNotFound(res.stderr, 'secrets', name)) return { exists: false, data: {} };
    throw new Error(`Couldn't read the secrets of "${cfg.name}": ${firstLine(res.stderr || res.stdout || 'kubectl failed')}`);
  }
  let obj;
  try {
    obj = JSON.parse(res.stdout);
  } catch (e) {
    obj = null;
  }
  const meta = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.metadata : null;
  const data = obj && obj.data === undefined ? {} : obj && obj.data;
  const isMap = data !== null && typeof data === 'object' && !Array.isArray(data) && Object.values(data).every((v) => typeof v === 'string');
  if (!meta || typeof meta.resourceVersion !== 'string' || !isMap) {
    throw new Error(`The cluster returned the Secret "${name}" in an unexpected form, so it won't be changed.`);
  }
  // Only a Secret localctl created is edited. Adopting one that happens to have the same name would
  // mix its keys into the app's environment (and `replace` would drop its labels' meaning).
  if ((meta.labels || {})[MANAGED_LABEL] !== 'true') {
    throw new Error(
      `A Secret named "${name}" already exists in namespace "${cfg.namespace}" and wasn't created by localctl. ` +
      `Rename it, or if it is yours: kubectl label secret ${name} -n ${cfg.namespace} ${MANAGED_LABEL}=true`,
    );
  }
  return { exists: true, data, resourceVersion: meta.resourceVersion, labels: meta.labels, annotations: meta.annotations };
}

function readRaw(cfg) {
  return readSecret(cfg).data;
}

function readAll(cfg) {
  return Object.fromEntries(Object.entries(readRaw(cfg)).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
}

// Writes the Secret with create/replace, not `apply`: apply keeps a copy of what it sent in the
// kubectl.kubernetes.io/last-applied-configuration annotation, which would leave every value
// readable in plain text next to the Secret, and it doesn't drop a key that is no longer in the
// new data. `replace` carries the resourceVersion that was read, so if someone changed the Secret
// in between, the write is refused (returns false) instead of silently overwriting their change.
function writeSecret(cfg, snapshot, data) {
  const name = secretNameFor(cfg);
  const annotations = { ...(snapshot.annotations || {}) };
  delete annotations[LAST_APPLIED]; // a copy of old plaintext values from an earlier `kubectl apply`
  const metadata = { name, namespace: cfg.namespace, labels: { ...(snapshot.labels || {}), [MANAGED_LABEL]: 'true' } };
  if (Object.keys(annotations).length) metadata.annotations = annotations;
  if (snapshot.exists) metadata.resourceVersion = snapshot.resourceVersion;
  const doc = { apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', data };
  const res = capture('kubectl', [snapshot.exists ? 'replace' : 'create', '-f', '-', '--request-timeout=30s'], { input: JSON.stringify(doc) });
  if (res.status === 0) return true;
  // Changed or created by someone else meanwhile, or deleted since we read it: read again and retry.
  if (isConflict(res.stderr) || (snapshot.exists && isNotFound(res.stderr, 'secrets', name))) return false;
  throw new Error(`Couldn't write the secrets of "${cfg.name}": ${firstLine(res.stderr || res.stdout || 'kubectl failed')}`);
}

// Read-modify-write that survives two processes changing the same Secret at once: on a conflict it
// reads again and re-applies the change. `change(data)` returns the new data, or null for "nothing
// to do".
function updateSecret(cfg, change) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = readSecret(cfg);
    const next = change({ ...snapshot.data });
    if (next === null) return false;
    if (Object.keys(next).length === 0) {
      // Empty the Secret under the same resourceVersion check first (so a concurrent writer is
      // noticed), then remove it.
      if (snapshot.exists && !writeSecret(cfg, snapshot, {})) {
        sleepSync(100 + Math.floor(Math.random() * 300));
        continue;
      }
      run('kubectl', ['delete', 'secret', secretNameFor(cfg), '-n', cfg.namespace, '--ignore-not-found=true'], { stdio: 'ignore' });
      return true;
    }
    ensureNamespace(cfg.namespace, cfg.name);
    if (writeSecret(cfg, snapshot, next)) return true;
    sleepSync(100 + Math.floor(Math.random() * 300));
  }
  throw new Error(`The secrets of "${cfg.name}" kept changing while updating them; try again.`);
}

function assertKey(key) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key.length > 253) throw new Error(`"${key}" is not a valid secret name: use UPPER_SNAKE_CASE.`);
}

function setSecret(cfg, key, value) {
  assertKey(key);
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > MAX_VALUE_BYTES) throw new Error(`The value for "${key}" is ${Math.round(bytes.length / 1024)} KB; a secret value can be at most ${MAX_VALUE_BYTES / 1024} KB.`);
  updateSecret(cfg, (data) => ({ ...data, [key]: bytes.toString('base64') }));
}

function unsetSecret(cfg, key) {
  assertKey(key);
  let found = false;
  updateSecret(cfg, (data) => {
    if (!(key in data)) return null;
    found = true;
    delete data[key];
    return data;
  });
  return found;
}

function listKeys(cfg) {
  return Object.keys(readRaw(cfg));
}

module.exports = { secretNameFor, setSecret, unsetSecret, listKeys, readAll };
