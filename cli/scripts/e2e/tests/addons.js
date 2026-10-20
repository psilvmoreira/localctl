// Dependencies (Helm-chart-backed addons). These download a chart and an image from the
// internet and run extra pods, so they are the slowest tests: skip with `--skip addons`.
const path = require('path');
const { writeAppFiles, writeConfig } = require('./fixtures');

module.exports = function register(runner, { ws }) {
  const S = runner.shared;

  runner.add({
    id: 'addon-redis', group: 'addons', needs: ['cluster-provision', 'app-new'], timeoutMs: 1200000,
    title: 'a "redis" dependency is deployed and its credentials are injected',
    run: async (t) => {
      const dir = path.join(ws.apps, 'cache-app');
      require('fs').mkdirSync(dir, { recursive: true });
      t.cli(['app', 'new'], { cwd: dir, input: 'e2e-cache\n3000\n' });
      writeAppFiles(dir);
      writeConfig(dir, { sync: [], dependencies: [{ type: 'redis' }] });

      t.cli(['app', 'up'], { cwd: dir, timeoutMs: 1200000 });
      const env = t.cli(['app', 'exec', 'env'], { cwd: dir }).stdout;
      t.contains(env, 'REDIS_HOST=', 'app environment');
      t.contains(env, 'REDIS_PASSWORD=', 'app environment');
      t.contains(t.cli(['app', 'status'], { cwd: dir }).stdout, 'redis', 'status (dependency)');

      t.cli(['app', 'down'], { cwd: dir, timeoutMs: 300000 });
      t.cli(['app', 'prune', '--yes'], { cwd: dir });
      S.addonDone = true;
    },
  });
};
