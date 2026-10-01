const { loadConfig } = require('../lib/loadConfig');
const { ensureClusterUp } = require('../lib/clusterProvision');
const { setSecret, unsetSecret, listKeys, readAll } = require('../lib/appSecrets');
const { promptHidden } = require('../lib/prompt');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

module.exports = (program) => {
  const secrets = program.command('secrets').description('Manage this app\'s own secrets (API keys, tokens - not addon-generated credentials)');

  secrets
    .command('set <key> [value]')
    .description('Set a secret value (prompts, hidden, if not given) - stored as a real k8s Secret, never in .local/config.json')
    .action(async (key, value) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      if (!cfg.secrets.includes(key)) {
        logger.warn(`"${key}" isn't listed in .local/config.json's "secrets" array - it won't be injected into the app until you add it there too.`);
      }
      const finalValue = value || (await promptHidden(`Value for ${key}`));
      if (!finalValue) throw new Error('No value given.');
      setSecret(cfg, key, finalValue);
      logger.success(`Set "${key}". Run "localctl app up"/"localctl app reload" to pick it up.`);
    });

  secrets
    .command('unset <key>')
    .description('Remove a secret value')
    .action((key) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      const removed = unsetSecret(cfg, key);
      if (removed) logger.success(`Removed "${key}".`);
      else logger.info(`"${key}" wasn't set.`);
    });

  secrets
    .command('list')
    .description('List which secret keys are set (not their values)')
    .action(() => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      const set = new Set(listKeys(cfg));
      if (cfg.secrets.length === 0 && set.size === 0) {
        logger.info('No secrets declared or set for this app.');
        return;
      }
      const rows = [...new Set([...cfg.secrets, ...set])].map((key) => [
        key,
        set.has(key) ? ui.ok('set') : ui.warn('missing'),
        cfg.secrets.includes(key) ? '' : ui.dim('(not in config.json)'),
      ]);
      ui.printTable(['KEY', 'STATUS', ''], rows);
    });

  secrets
    .command('show [key]')
    .description('Reveal actual secret value(s) - use with care, prints them to your terminal')
    .action((key) => {
      const cfg = loadConfig();
      ensureClusterUp(cfg.clusterName, cfg.profile);
      const data = readAll(cfg);
      if (key) {
        if (!(key in data)) throw new Error(`"${key}" isn't set. Run "localctl app secrets set ${key}".`);
        console.log(data[key]);
        return;
      }
      if (Object.keys(data).length === 0) {
        logger.info('No secrets set for this app.');
        return;
      }
      logger.warn('Revealing real secret values - avoid leaving these in your terminal scrollback/screen share.');
      Object.entries(data).forEach(([k, v]) => console.log(`${k}=${v}`));
    });
};
