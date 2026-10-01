const fs = require('fs');
const path = require('path');
const { askAll } = require('../lib/prompt');
const logger = require('../lib/logger');

module.exports = (program) => {
  program
    .command('new')
    .description('Scaffold .local/config.json and a Tiltfile in the current app repo')
    .action(async () => {
      const cwd = process.cwd();
      const localDir = path.join(cwd, '.local');
      const configPath = path.join(localDir, 'config.json');

      if (fs.existsSync(configPath)) {
        logger.warn('.local/config.json already exists, aborting.');
        return;
      }

      const defaultName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const [name, portAnswer] = await askAll([
        { text: 'App name', def: defaultName },
        { text: 'App port', def: '3000' },
      ]);

      const port = parseInt(portAnswer, 10);

      fs.mkdirSync(localDir, { recursive: true });

      const config = {
        $schema: '../../localctl/schema/app.schema.json',
        name,
        subdomain: name,
        port,
        build: { context: '.', dockerfile: 'Dockerfile' },
        env: {},
        replicas: 1,
        debug: { enabled: false },
        dependencies: [],
        sync: [{ localPath: './src', remotePath: '/app/src' }],
        tls: true,
      };
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      const tiltTemplatePath = path.join(__dirname, '..', '..', 'templates', 'Tiltfile.tmpl');
      const tiltTemplate = fs.readFileSync(tiltTemplatePath, 'utf8');
      const tiltfilePath = path.join(cwd, 'Tiltfile');
      if (!fs.existsSync(tiltfilePath)) {
        fs.writeFileSync(tiltfilePath, tiltTemplate);
      }

      logger.success(`Created .local/config.json and Tiltfile for "${name}".`);
      logger.info('Edit .local/config.json (env, dependencies, debug), then run "localctl app up".');
    });
};
