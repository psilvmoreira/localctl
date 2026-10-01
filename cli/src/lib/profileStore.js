const fs = require('fs');
const { HOME_STATE_DIR, PROFILES_PATH } = require('./paths');
const { DEFAULT_CLUSTER_NAME, DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT, REGISTRY_HOST_PORT } = require('./constants');

// ~/.localctl/profiles.json is the single source of truth for every project this machine knows
// about, and which one ad-hoc/global commands (doctor, hosts, addons) currently target.
//
// Two kinds of profile, distinguished by `isolation`:
//   - "cluster" (a "Main project"): owns a real, separate k3d cluster/registry - `cluster`,
//     `exclusive`, and (for a non-exclusive one, which needs its own ports since two clusters
//     can't both bind host :80/:443) `httpPort`/`httpsPort`/`registryPort` all live here.
//   - "namespace" (nested under exactly one Main project via `parent`): shares that Main
//     project's cluster/registry/cert, isolated only by a namespace + subdomain prefix
//     (`namespace`, defaulting to its own name).
//
// "default" always exists - it's today's single always-there cluster, `local-dev`.
function defaultRegistry() {
  return {
    active: 'default',
    profiles: {
      default: { isolation: 'cluster', cluster: DEFAULT_CLUSTER_NAME, exclusive: true },
    },
  };
}

function ensureRegistry() {
  if (!fs.existsSync(HOME_STATE_DIR)) fs.mkdirSync(HOME_STATE_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_PATH)) save(defaultRegistry());
}

function load() {
  ensureRegistry();
  return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2));
}

function getProfile(name) {
  return load().profiles[name] || null;
}

function upsertProfile(name, def) {
  const data = load();
  data.profiles[name] = def;
  save(data);
}

function listProfiles() {
  return load().profiles;
}

function getActive() {
  return load().active;
}

function setActive(name) {
  const data = load();
  if (!data.profiles[name]) throw new Error(`Unknown profile "${name}". Run "localctl profiles list".`);
  data.active = name;
  save(data);
}

// Climbs `parent` links up to the Main (isolation: "cluster") project that actually owns a
// cluster - a namespace-level project's own entry never has one.
function mainProjectFor(name) {
  const { profiles } = load();
  let cur = name;
  const seen = new Set();
  for (;;) {
    if (seen.has(cur)) throw new Error(`Circular "parent" chain detected starting at profile "${cur}".`);
    seen.add(cur);
    const def = profiles[cur];
    if (!def) {
      throw new Error(`Unknown profile "${cur}". Run "localctl profiles list", or "localctl profiles new ${cur}" to create it.`);
    }
    if (def.isolation === 'cluster') return { name: cur, def };
    cur = def.parent;
  }
}

function clusterNameFor(name) {
  return mainProjectFor(name).def.cluster;
}

function portsFor(name) {
  const { def } = mainProjectFor(name);
  return {
    httpPort: def.httpPort || DEFAULT_HTTP_PORT,
    httpsPort: def.httpsPort || DEFAULT_HTTPS_PORT,
    registryPort: def.registryPort || REGISTRY_HOST_PORT,
  };
}

// The namespace/subdomain prefix a namespace-level project's apps get scoped under - null for a
// Main project itself (it owns the whole cluster, nothing to prefix).
function namespaceScopeFor(name) {
  const def = getProfile(name);
  if (!def) throw new Error(`Unknown profile "${name}". Run "localctl profiles list".`);
  if (def.isolation === 'cluster') return null;
  return def.namespace || name;
}

// Every namespace-level project nested under a given Main project, for `profiles list`.
function childrenOf(mainName) {
  const { profiles } = load();
  return Object.entries(profiles)
    .filter(([, def]) => def.isolation === 'namespace' && def.parent === mainName)
    .map(([name]) => name);
}

function removeProfile(name) {
  const data = load();
  delete data.profiles[name];
  if (data.active === name) data.active = 'default';
  save(data);
}

module.exports = {
  load,
  save,
  getProfile,
  upsertProfile,
  removeProfile,
  listProfiles,
  getActive,
  setActive,
  mainProjectFor,
  clusterNameFor,
  portsFor,
  namespaceScopeFor,
  childrenOf,
};
