const fs = require('fs');
const path = require('path');
const { appConfigSchema } = require('./configSchema');
const { CONFIG_PATH } = require('./paths');
const { resolveProfileName } = require('./projectContext');
const { getProfile, clusterNameFor, namespaceScopeFor } = require('./profileStore');

function loadConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config found at ${configPath}. Run "localctl app new" first.`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid .local/config.json:\n${issues}`);
  }
  const cfg = parsed.data;
  cfg.namespace = cfg.namespace || cfg.name;
  cfg.subdomain = cfg.subdomain || cfg.name;

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
    cfg.subdomain = `${scope}-${cfg.subdomain}`;
  }

  cfg.profile = profileName;
  cfg.clusterName = clusterNameFor(profileName);
  return cfg;
}

module.exports = { loadConfig };
