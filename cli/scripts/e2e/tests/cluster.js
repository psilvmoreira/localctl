// Tests against a real k3d cluster, created just for this run (localctl-e2e) with its own ports
// and registry. They follow an app's real life: create project -> deploy -> use -> tear down.
const fs = require('fs');
const path = require('path');
const { PROFILE, CLUSTER, REGISTRY_PORT } = require('../lib/context');
const { MARKER, writeAppFiles, readConfig, writeConfig, writeProjectFile } = require('./fixtures');

const TOKEN_KEY = 'E2E_TOKEN';
const TOKEN_VALUE = 'e2e-secret-value';

module.exports = function register(runner, { ws, engineBin }) {
  const S = runner.shared;
  const host = 'e2e-web.local.test';
  const url = () => `https://${host}:${S.ports.httpsPort}/`;
  const appDir = () => S.appDir;

  // curl that verifies the certificate against mkcert's CA - the same trust a browser has -
  // while resolving the name without needing a hosts entry.
  const curlHttps = (t, hostname, port) => {
    const caRoot = t.sh('mkcert', ['-CAROOT']).stdout;
    return t.sh('curl', [
      '-sS', '--max-time', '10', '--cacert', path.join(caRoot, 'rootCA.pem'),
      '--resolve', `${hostname}:${port}:127.0.0.1`, `https://${hostname}:${port}/`,
    ], { allowFail: true });
  };

  // ---- the cluster itself ---------------------------------------------------------------
  runner.add({
    id: 'cluster-provision', group: 'cluster', timeoutMs: 900000,
    title: 'a project cluster is created (k3d, registry, TLS, Traefik)',
    run: async (t) => {
      t.cli(['profiles', 'switch', PROFILE], { timeoutMs: 900000 });
    },
  });

  runner.add({
    id: 'cluster-api', group: 'cluster', needs: ['cluster-provision'],
    title: 'the API answers and kubeconfig does not use 0.0.0.0',
    run: async (t) => {
      t.kubectl(['get', '--raw', '/readyz']);
      const server = t.kubectl(['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}']).stdout;
      t.assert.ok(!server.includes('0.0.0.0'), `kubeconfig points at ${server}`);
    },
  });

  runner.add({
    id: 'cluster-registry', group: 'cluster', needs: ['cluster-provision'],
    title: 'the local image registry is running and reachable',
    run: async (t) => {
      const names = t.sh(engineBin, ['ps', '--format', '{{.Names}}']).stdout;
      t.contains(names, `${CLUSTER}-registry`, 'running containers');
      await t.poll('registry /v2/ answers 200', () => {
        const r = t.sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://localhost:${S.ports.registryPort}/v2/`], { allowFail: true });
        return r.stdout === '200';
      }, { timeoutMs: 30000 });
    },
  });

  runner.add({
    id: 'cluster-tls', group: 'cluster', needs: ['cluster-provision'],
    title: 'the *.local.test certificate is wired in as Traefik\'s default',
    run: async (t) => {
      t.kubectl(['get', 'secret', 'local-dev-tls', '-n', 'kube-system']);
      await t.poll('TLSStore "default" exists', () => t.kubectl(['get', 'tlsstore', 'default', '-n', 'kube-system'], { allowFail: true }).status === 0);
      t.kubectl(['get', 'namespace', 'observability']);
    },
  });

  runner.add({
    id: 'cluster-lightweight', group: 'cluster', needs: ['cluster-provision'],
    title: 'metrics-server is not running, and servicelb is (it opens :80/:443)',
    run: async (t) => {
      const ms = t.kubectl(['get', 'deployment', 'metrics-server', '-n', 'kube-system'], { allowFail: true });
      t.assert.notStrictEqual(ms.status, 0, 'metrics-server is deployed');
      await t.poll('svclb-traefik pod exists', () => t.kubectl(['get', 'pods', '-n', 'kube-system', '-o', 'name']).stdout.includes('svclb-traefik'));
    },
  });

  runner.add({
    id: 'profiles-cluster-up', group: 'cluster', needs: ['cluster-provision'],
    title: '"profiles list" shows the cluster as up',
    run: async (t) => {
      const list = t.cli(['profiles', 'list']).stdout;
      t.assert.ok(/e2e[\s\S]*up/.test(list), `cluster not shown as up:\n${list}`);
    },
  });

  // ---- an app's life --------------------------------------------------------------------
  runner.add({
    id: 'secrets-required', group: 'app-lifecycle', needs: ['cluster-provision', 'app-new'],
    title: '"app up" refuses to start while a declared secret has no value',
    run: async (t) => {
      writeConfig(appDir(), { secrets: [TOKEN_KEY] });
      const out = t.cli(['app', 'up'], { cwd: appDir(), allowFail: true });
      t.assert.notStrictEqual(out.status, 0, 'app up succeeded without the secret');
      t.contains(out.all, 'Missing secret');
      t.contains(out.all, TOKEN_KEY);
    },
  });

  runner.add({
    id: 'secrets-set', group: 'app-lifecycle', needs: ['secrets-required'],
    title: '"app secrets set/list/show" store the value as a Kubernetes Secret',
    run: async (t) => {
      t.cli(['app', 'secrets', 'set', TOKEN_KEY, TOKEN_VALUE], { cwd: appDir() });
      t.contains(t.cli(['app', 'secrets', 'list'], { cwd: appDir() }).stdout, TOKEN_KEY, 'secrets list');
      t.assert.strictEqual(t.cli(['app', 'secrets', 'show', TOKEN_KEY], { cwd: appDir() }).stdout, TOKEN_VALUE);
      t.kubectl(['get', 'secret', 'e2e-web-secrets', '-n', 'e2e-web']);
    },
  });

  runner.add({
    id: 'app-up', group: 'app-lifecycle', needs: ['secrets-set'], timeoutMs: 900000,
    title: '"app up" builds, pushes, deploys and waits until the app is ready',
    run: async (t) => {
      const out = t.cli(['app', 'up'], { cwd: appDir(), timeoutMs: 900000 });
      t.contains(out.stdout, `${host}:${S.ports.httpsPort}`, 'app up output');
      const ready = t.kubectl(['get', 'deployment', 'e2e-web', '-n', 'e2e-web', '-o', 'jsonpath={.status.readyReplicas}']).stdout;
      t.assert.strictEqual(ready, '1');
    },
  });

  runner.add({
    id: 'app-https', group: 'app-lifecycle', needs: ['app-up'],
    title: 'the app answers over HTTPS with a certificate the system trusts',
    run: async (t) => {
      await t.poll(`${url()} returns the app page`, () => curlHttps(t, host, S.ports.httpsPort).stdout.includes(MARKER), { timeoutMs: 90000 });
    },
  });

  runner.add({
    id: 'app-hosts', group: 'app-lifecycle', needs: ['app-up'],
    title: '"app up" registered the subdomain in the hosts file',
    run: async (t) => {
      t.contains(fs.readFileSync(ws.hostsFile, 'utf8'), `127.0.0.1 ${host}`, 'hosts file');
    },
  });

  runner.add({
    id: 'app-status', group: 'app-lifecycle', needs: ['app-up'],
    title: '"app status" shows readiness, URL and the dev loop (single app and --all)',
    run: async (t) => {
      const one = t.cli(['app', 'status'], { cwd: appDir() }).stdout;
      t.contains(one, 'e2e-web', 'status');
      t.contains(one, 'running', 'status (dev loop)');
      t.contains(one, host, 'status (url)');
      t.contains(t.cli(['app', 'status', '--all'], { cwd: appDir() }).stdout, 'e2e-web', 'status --all');
    },
  });

  runner.add({
    id: 'app-logs', group: 'app-lifecycle', needs: ['app-https'],
    title: '"app logs" returns the pod logs',
    run: async (t) => {
      // busybox httpd -v logs each request, and app-https made one.
      await t.poll('log output', () => t.cli(['app', 'logs'], { cwd: appDir() }).all.length > 0, { timeoutMs: 30000 });
    },
  });

  runner.add({
    id: 'app-exec', group: 'app-lifecycle', needs: ['app-up'],
    title: '"app exec" runs in the pod and the secret was injected as an env var',
    run: async (t) => {
      const out = t.cli(['app', 'exec', 'printenv', TOKEN_KEY], { cwd: appDir() });
      t.contains(out.stdout, TOKEN_VALUE, 'exec output');
    },
  });

  runner.add({
    id: 'app-reload', group: 'app-lifecycle', needs: ['app-up'],
    title: '"app reload" triggers a rebuild of the running dev loop',
    run: async (t) => {
      const out = t.cli(['app', 'reload'], { cwd: appDir() });
      t.contains(out.all, 'reload triggered');
    },
  });

  runner.add({
    id: 'secrets-unset', group: 'app-lifecycle', needs: ['app-exec'],
    title: '"app secrets unset" removes the value (the key stays declared, as "missing")',
    run: async (t) => {
      t.cli(['app', 'secrets', 'unset', TOKEN_KEY], { cwd: appDir() });
      const list = t.cli(['app', 'secrets', 'list'], { cwd: appDir() }).stdout;
      const row = list.split('\n').find((l) => l.includes(TOKEN_KEY)) || '';
      t.assert.ok(/missing/.test(row), `expected ${TOKEN_KEY} to be "missing" after unset, got:\n${list}`);
      const shown = t.cli(['app', 'secrets', 'show', TOKEN_KEY], { cwd: appDir(), allowFail: true });
      t.assert.notStrictEqual(shown.status, 0, 'the value is still readable after unset');
    },
  });

  runner.add({
    id: 'app-down', group: 'app-lifecycle', needs: ['app-up'], timeoutMs: 300000,
    title: '"app down" stops the dev loop and removes the deployment',
    run: async (t) => {
      t.cli(['app', 'down'], { cwd: appDir(), timeoutMs: 300000 });
      await t.poll('deployment is gone', () => t.kubectl(['get', 'deployment', 'e2e-web', '-n', 'e2e-web'], { allowFail: true }).status !== 0);
      t.assert.ok(!fs.existsSync(path.join(ws.home, 'run', 'e2e-web.pid')), 'dev loop pid file left behind');
    },
  });

  runner.add({
    id: 'app-prune', group: 'app-lifecycle', needs: ['app-down', 'secrets-unset'],
    title: '"app prune" leaves an empty namespace alone, and deletes one that still holds data',
    run: async (t) => {
      // Nothing left (the last secret was just unset): prune must say so and change nothing.
      const none = t.cli(['app', 'prune', '--yes'], { cwd: appDir() });
      t.contains(none.all, 'Nothing left to prune');
      t.kubectl(['get', 'namespace', 'e2e-web']);

      // Leave data behind, the way a dependency's volume or a secret would.
      t.cli(['app', 'secrets', 'set', TOKEN_KEY, TOKEN_VALUE], { cwd: appDir() });
      t.cli(['app', 'prune', '--yes'], { cwd: appDir() });
      await t.poll('namespace is gone', () => t.kubectl(['get', 'namespace', 'e2e-web'], { allowFail: true }).status !== 0, { timeoutMs: 120000 });
    },
  });

  // ---- a namespace-scoped project sharing the same cluster --------------------------------
  runner.add({
    id: 'namespace-project', group: 'projects', needs: ['cluster-provision', 'app-new'], timeoutMs: 900000,
    title: 'a namespace-scoped project shares the cluster and prefixes its apps',
    run: async (t) => {
      const root = path.join(ws.apps, 'nsroot');
      const dir = path.join(root, 'api');
      fs.mkdirSync(dir, { recursive: true });
      // `profiles new` asks: own cluster or namespace? -> parent project -> prefix.
      t.cli(['profiles', 'new', 'e2ens'], { cwd: root, input: 'namespace\ne2e\ne2ens\n' });
      t.assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.local', 'project.json'), 'utf8')).profile, 'e2ens');
      t.contains(t.cli(['profiles', 'list']).stdout, 'e2ens', 'profiles list');

      t.cli(['app', 'new'], { cwd: dir, input: 'e2e-api\n3000\n' });
      writeAppFiles(dir);
      writeConfig(dir, { sync: [] });
      t.assert.strictEqual(readConfig(dir).name, 'e2e-api');

      t.cli(['app', 'up'], { cwd: dir, timeoutMs: 900000 });
      const ready = t.kubectl(['get', 'deployment', 'e2e-api', '-n', 'e2ens-e2e-api', '-o', 'jsonpath={.status.readyReplicas}']).stdout;
      t.assert.strictEqual(ready, '1');
      const r = curlHttps(t, 'e2ens-e2e-api.local.test', S.ports.httpsPort);
      t.assert.ok(r.stdout.includes(MARKER), `unexpected response: ${r.all}`);

      t.cli(['app', 'down'], { cwd: dir, timeoutMs: 300000 });
      t.cli(['app', 'prune', '--yes'], { cwd: dir });
    },
  });
};
