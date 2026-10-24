const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./yamlLoad');
const { appConfigSchema, describeIssues } = require('./configSchema');
const { readEnvFile } = require('./envFile');
const { isReservedNamespace } = require('./namespaces');
const { readRegularFile } = require('./safeRead');
const { assertPathsInsideProject } = require('./pathGuard');
const { CONFIG_PATH } = require('./paths');
const { resolveProfileName } = require('./projectContext');
const { getProfile, clusterNameFor, namespaceScopeFor } = require('./profileStore');

// YAML turns `PORT: 3000` or `DEBUG: true` into a number or boolean, but environment variables
// are always strings. Convert scalars instead of rejecting them. (yamlLoad.js already keeps
// values such as 1.10, 1e3, 0x10, 0777 and dates as text.)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stringifyEnv(env) {
  if (env === null) return undefined;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return env;
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === '__proto__') continue; // would change the object's prototype instead of adding a variable
    out[key] = value === null ? '' : ['number', 'boolean'].includes(typeof value) ? String(value) : value;
  }
  return out;
}

const MAX_CONFIG_BYTES = 512 * 1024;
// Counted in nodes, where a string weighs as many as it has characters, so one long string that is
// aliased thousands of times can't slip past as "one node each".
const MAX_EXPANDED_NODES = 2000000;

// YAML aliases let a tiny file expand into a huge tree (the "billion laughs" shape), which would
// make validation burn CPU. Count the size of the tree as it would be expanded, sharing the work
// for repeated nodes, and refuse documents that are too big or that loop back on themselves.
function assertReasonableSize(value) {
  const sizes = new Map();
  const inProgress = new Set();
  const size = (node) => {
    if (typeof node === 'string') return Math.max(1, node.length);
    if (node === null || typeof node !== 'object') return 1;
    if (sizes.has(node)) return sizes.get(node);
    if (inProgress.has(node)) throw new Error('Invalid .local/config.yaml: it contains a YAML anchor that refers to itself.');
    inProgress.add(node);
    let total = 1;
    // Keys count by length too: a long key aliased many times is as costly as a long value.
    const children = Array.isArray(node) ? node.map((c) => [0, c]) : Object.entries(node).map(([k, c]) => [k.length, c]);
    for (const [keyWeight, child] of children) {
      total += keyWeight + size(child);
      if (total > MAX_EXPANDED_NODES) {
        throw new Error('Invalid .local/config.yaml: it is far larger than a config should be once YAML anchors/aliases are expanded.');
      }
    }
    inProgress.delete(node);
    sizes.set(node, total);
    return total;
  };
  try {
    size(value);
  } catch (e) {
    if (e instanceof RangeError) throw new Error('Invalid .local/config.yaml: it is nested too deeply.');
    throw e;
  }
}

// Reads and parses the app's YAML config without validating it. Used by loadConfig and by
// commands that only need a field or two (like the app name).
function readRawConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    const legacy = path.join(path.dirname(configPath), 'config.json');
    if (fs.existsSync(legacy)) {
      throw new Error(
        `Found ${legacy}, but localctl now reads .local/config.yaml. Convert it (JSON is valid ` +
        'YAML, so renaming the file to config.yaml works as a first step) and delete the old file.',
      );
    }
    throw new Error(`No config found at ${configPath}. Run "localctl app new" first.`);
  }
  // The .local folder itself must be a real folder too, not a link to a config somewhere else.
  try {
    if (fs.lstatSync(path.dirname(configPath)).isSymbolicLink()) throw new Error('Invalid .local/config.yaml: the .local folder is a symbolic link; use a real folder.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let raw;
  try {
    raw = loadYaml(readRegularFile(configPath, MAX_CONFIG_BYTES, '.local/config.yaml'));
  } catch (e) {
    if (e.name !== 'YAMLException') throw new Error(`Invalid .local/config.yaml: ${e.message}`);
    throw new Error(`Invalid .local/config.yaml (not valid YAML):\n  ${e.message.split('\n')[0]}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid .local/config.yaml: expected a mapping of settings at the top level.');
  }
  assertReasonableSize(raw);
  // A key left empty in YAML (`env:`) is null; treat it as not set so the schema defaults apply.
  for (const key of Object.keys(raw)) {
    if (raw[key] === null) delete raw[key];
  }
  raw.env = stringifyEnv(raw.env);
  for (const list of ['sidecars', 'initContainers']) {
    if (Array.isArray(raw[list])) {
      raw[list] = raw[list].map((c) => (c && typeof c === 'object' ? { ...c, env: stringifyEnv(c.env) } : c));
    }
  }
  return raw;
}

// Fields an environment can't override: they identify the app and where it lives, which other
// commands (down, secrets, status) resolve without knowing about environments.
const LOCKED_IN_ENVIRONMENT = ['name', 'namespace', 'environments', 'envFile'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Objects merge key by key, everything else (lists, scalars) is replaced.
function mergeConfig(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : value;
  }
  return out;
}

// Applies the named entry of `environments` over the rest of the file (or none when no name is
// given) and removes the `environments` block itself. The name comes from `localctl app up --env`
// via LOCALCTL_ENV and can only pick an entry that the file itself defines.
function applyEnvironment(raw, envName = process.env.LOCALCTL_ENV) {
  const { environments, ...base } = raw;
  const available = isPlainObject(environments) ? Object.keys(environments) : [];
  // Names are checked even when no environment is selected, so a bad one fails early.
  const badName = available.find((n) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(n) || n.length > 63);
  if (badName !== undefined) throw new Error(`Environment name "${badName}" must be lowercase letters, digits and dashes (like a Kubernetes name).`);
  if (!envName) return base;
  if (!available.includes(envName)) {
    throw new Error(
      `Unknown environment ${JSON.stringify(String(envName).slice(0, 80))}. ` +
      (available.length ? `This app defines: ${available.join(', ')}.` : 'This app\'s config has no "environments" block.'),
    );
  }
  const overlay = environments[envName];
  if (!isPlainObject(overlay)) throw new Error(`Environment "${envName}" must be a mapping of settings.`);
  const unsafe = Object.keys(overlay).find((k) => UNSAFE_KEYS.has(k));
  if (unsafe !== undefined) throw new Error(`Environment "${envName}" uses the reserved key "${unsafe}".`);
  const locked = LOCKED_IN_ENVIRONMENT.filter((k) => k in overlay);
  if (locked.length) {
    throw new Error(`Environment "${envName}" can't override ${locked.map((k) => `"${k}"`).join(', ')}.`);
  }
  return mergeConfig(base, readEnvOverlay(overlay));
}

// Same clean-up readRawConfig does for the base file, applied to the overlay.
function readEnvOverlay(overlay) {
  const out = { ...overlay };
  for (const key of Object.keys(out)) {
    if (out[key] === null) delete out[key];
  }
  if ('env' in out) out.env = stringifyEnv(out.env);
  for (const list of ['sidecars', 'initContainers']) {
    if (Array.isArray(out[list])) {
      out[list] = out[list].map((c) => (c && typeof c === 'object' ? { ...c, env: stringifyEnv(c.env) } : c));
    }
  }
  return out;
}

function loadConfig(configPath = CONFIG_PATH) {
  const raw = applyEnvironment(readRawConfig(configPath));
  // envFile values go under the explicit `env` keys, so the YAML always wins over the file.
  if (typeof raw.envFile === 'string') {
    raw.env = { ...readEnvFile(path.dirname(path.dirname(configPath)), raw.envFile), ...(raw.env || {}) };
  }
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid .local/config.yaml:\n${describeIssues(parsed.error.issues)}`);
  }
  const cfg = parsed.data;
  assertPathsInsideProject(cfg, path.dirname(path.dirname(configPath)));
  cfg.namespace = cfg.namespace || cfg.name;
  cfg.subdomain = cfg.subdomain || cfg.name;
  cfg.hosts = [cfg.subdomain, ...cfg.ingress.hosts];

  // Which project this app belongs to - walking up from the app's own directory for the nearest
  // .local/project.json, same lookup as git finding .git (see projectContext.js). No
  // project.json anywhere above it -> the app belongs to "default", today's single cluster,
  // unchanged.
  const appDir = path.dirname(path.dirname(configPath));
  const profileName = resolveProfileName(appDir);
  const profile = getProfile(profileName);
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" (from .local/project.json) isn't registered on this machine. ` +
      `Run "localctl profiles new ${profileName}" first.`,
    );
  }

  // A namespace-level project shares its parent's cluster, isolated only by a namespace/subdomain
  // prefix - a Main (cluster-isolation) project owns its whole cluster, nothing to prefix.
  const scope = namespaceScopeFor(profileName);
  if (scope) {
    cfg.namespace = `${scope}-${cfg.namespace}`;
    cfg.hosts = cfg.hosts.map((h) => `${scope}-${h}`);
    cfg.subdomain = cfg.hosts[0];
  }
  // The checks in the schema ran before the project prefix was added, so repeat the ones that
  // depend on the final names (a prefix could turn `system` into `kube-system`, or push a name
  // past the 63-character limit).
  if (isReservedNamespace(cfg.namespace)) {
    throw new Error(`The namespace "${cfg.namespace}" is reserved for Kubernetes and localctl itself; choose another "namespace" or "name".`);
  }
  for (const label of [cfg.namespace, ...cfg.hosts]) {
    if (label.length > 63) {
      throw new Error(`"${label}" is longer than 63 characters once the project prefix "${scope}-" is added; shorten the app name, namespace or hosts.`);
    }
  }

  cfg.profile = profileName;
  cfg.clusterName = clusterNameFor(profileName);
  return cfg;
}

module.exports = { loadConfig, readRawConfig, applyEnvironment };
