const { readRawConfig, applyEnvironment } = require('../lib/loadConfig');
const { appConfigSchema, describeIssues } = require('../lib/configSchema');
const { CONFIG_PATH } = require('../lib/paths');
const logger = require('../lib/logger');
const path = require('path');
const { readEnvFile } = require('../lib/envFile');
const { assertPathsInsideProject } = require('../lib/pathGuard');

module.exports = (program) => {
  program
    .command('validate')
    .description('Check .local/config.yaml and each of its environments (unknown fields, wrong types, bad values) without touching the cluster')
    .action(() => {
      const raw = readRawConfig(CONFIG_PATH);
      const names = Object.keys(raw.environments && typeof raw.environments === 'object' ? raw.environments : {});
      const problems = [];
      let base;
      // The base file, then each environment applied over it.
      for (const envName of [null, ...names]) {
        const label = envName ? `environment "${envName}"` : 'base config';
        try {
          const parsed = appConfigSchema.safeParse(applyEnvironment(raw, envName || ''));
          if (parsed.success) {
            // Same path check `app up` makes, so "valid" means it will be accepted there too.
            assertPathsInsideProject(parsed.data, path.dirname(path.dirname(CONFIG_PATH)));
            if (!envName) base = parsed.data;
          } else {
            problems.push(`${label}:\n${describeIssues(parsed.error.issues)}`);
          }
        } catch (e) {
          problems.push(`${label}: ${e.message}`);
        }
      }
      if (typeof raw.envFile === 'string') {
        try {
          readEnvFile(path.dirname(path.dirname(CONFIG_PATH)), raw.envFile);
        } catch (e) {
          problems.push(e.message);
        }
      }
      if (problems.length) throw new Error(`Invalid .local/config.yaml:\n${problems.join('\n')}`);
      const deps = base.dependencies.map((d) => d.type);
      logger.success(
        `.local/config.yaml is valid: "${base.name}" on port ${base.port}` +
        `${deps.length ? `, with ${deps.join(', ')}` : ''}${names.length ? `; environments: ${names.join(', ')}` : ''}.`,
      );
    });
};
