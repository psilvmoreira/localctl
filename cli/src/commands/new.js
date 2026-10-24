const fs = require('fs');
const path = require('path');
const { askAll } = require('../lib/prompt');
const logger = require('../lib/logger');

module.exports = (program) => {
  program
    .command('new')
    .description('Scaffold .local/config.yaml and a Tiltfile in the current app repo')
    .action(async () => {
      const cwd = process.cwd();
      const localDir = path.join(cwd, '.local');
      const configPath = path.join(localDir, 'config.yaml');

      if (fs.existsSync(configPath)) {
        logger.warn('.local/config.yaml already exists, aborting.');
        return;
      }

      const defaultName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'app';
      const [name, portAnswer] = await askAll([
        { text: 'App name', def: defaultName },
        { text: 'App port', def: '3000' },
      ]);

      const port = parseInt(portAnswer, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`"${portAnswer}" is not a valid port (1-65535).`);
      }
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 63) {
        throw new Error(`"${name}" is not a valid app name: use lowercase letters, digits and dashes only.`);
      }

      fs.mkdirSync(localDir, { recursive: true });

      const config = [
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/psilvmoreira/localctl/master/schema/app.schema.json',
        '# Infrastructure config for this app. Reference: https://psilvmoreira.github.io/localctl/config-schema/',
        `name: ${JSON.stringify(name)}`,
        `subdomain: ${JSON.stringify(name)}`,
        `port: ${port}`,
        'build:',
        '  context: .',
        '  dockerfile: Dockerfile',
        '# Plain environment variables. Quote values whose exact text matters ("1.10", "no").',
        '# API keys and passwords belong in "secrets" below, never here.',
        'env: {}',
        '# Names only; set values with: localctl app secrets set <NAME>',
        '# secrets:',
        '#   - API_KEY',
        '# Other options (see the config schema reference): command / args to override the image',
        '# CMD, envFile: .env.local for non-secret settings, build.target / build.args, run steps after sync.',
        'replicas: 1',
        'debug:',
        '  enabled: false',
        '# Databases and caches deployed next to the app: postgres, redis or mongo.',
        'dependencies: []',
        '# Files copied into the running container on save (live update).',
        'sync:',
        '  - localPath: ./src',
        '    remotePath: /app/src',
        'tls: true',
        '',
      ].join('\n');
      fs.writeFileSync(configPath, config);

      const tiltTemplatePath = path.join(__dirname, '..', '..', 'templates', 'Tiltfile.tmpl');
      const tiltTemplate = fs.readFileSync(tiltTemplatePath, 'utf8');
      const tiltfilePath = path.join(cwd, 'Tiltfile');
      if (!fs.existsSync(tiltfilePath)) {
        fs.writeFileSync(tiltfilePath, tiltTemplate);
      }

      logger.success(`Created .local/config.yaml and Tiltfile for "${name}".`);
      logger.info('Edit .local/config.yaml (env, dependencies, debug), then run "localctl app up".');
    });
};
