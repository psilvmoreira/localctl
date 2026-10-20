// Tests that need no cluster: they run first, before anything of yours is stopped.
const fs = require('fs');
const path = require('path');
const { CLUSTER, REGISTRY_PORT, PROFILE } = require('../lib/context');
const { writeAppFiles, readConfig, writeConfig, writeProjectFile } = require('./fixtures');

const pkg = require('../../../package.json');
const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

module.exports = function register(runner, { ws }) {
  const appDir = path.join(ws.apps, 'web');
  runner.shared.appDir = appDir;

  // ---- CLI surface -------------------------------------------------------------------------
  runner.add({
    id: 'cli-version', group: 'cli', title: '--version matches package.json',
    run: async (t) => {
      const out = t.cli(['--version']);
      t.assert.strictEqual(out.stdout, pkg.version);
    },
  });

  runner.add({
    id: 'cli-help', group: 'cli', title: 'every command answers --help',
    run: async (t) => {
      const groups = [
        [], ['setup'], ['uninstall'], ['doctor'], ['hosts'], ['addons'], ['profiles'], ['app'],
        ['app', 'new'], ['app', 'up'], ['app', 'down'], ['app', 'status'], ['app', 'logs'],
        ['app', 'reload'], ['app', 'exec'], ['app', 'prune'], ['app', 'secrets'],
        ['app', 'generate-manifests'], ['app', 'registry-info'],
      ];
      groups.forEach((g) => t.cli([...g, '--help']));
    },
  });

  // ---- app scaffolding and manifest generation --------------------------------------------
  runner.add({
    id: 'app-new', group: 'app', title: '"app new" scaffolds .local/config.json and a Tiltfile',
    run: async (t) => {
      fs.mkdirSync(appDir, { recursive: true });
      writeProjectFile(ws.apps);
      t.cli(['app', 'new'], { cwd: appDir, input: 'e2e-web\n3000\n' });
      const cfg = readConfig(appDir);
      t.assert.strictEqual(cfg.name, 'e2e-web');
      t.assert.strictEqual(cfg.port, 3000);
      t.assert.ok(fs.existsSync(path.join(appDir, 'Tiltfile')), 'Tiltfile was not created');
      writeAppFiles(appDir);
      // `app new` points live-sync at ./src, which this fixture doesn't have.
      writeConfig(appDir, { sync: [] });
    },
  });

  runner.add({
    id: 'app-new-refuses-overwrite', group: 'app', needs: ['app-new'],
    title: '"app new" does not overwrite an existing config',
    run: async (t) => {
      const before = fs.readFileSync(path.join(appDir, '.local', 'config.json'), 'utf8');
      const out = t.cli(['app', 'new'], { cwd: appDir, input: 'other\n9999\n' });
      t.contains(out.all, 'already exists');
      t.assert.strictEqual(fs.readFileSync(path.join(appDir, '.local', 'config.json'), 'utf8'), before);
    },
  });

  runner.add({
    id: 'manifests', group: 'app', needs: ['app-new'],
    title: '"generate-manifests" renders Namespace, Deployment, Service and Ingress',
    run: async (t) => {
      const out = t.cli(['app', 'generate-manifests'], { cwd: appDir });
      ['kind: Namespace', 'kind: Deployment', 'kind: Service', 'kind: Ingress'].forEach((k) => t.contains(out.stdout, k, 'manifests'));
      t.contains(out.stdout, 'localctl.dev/managed', 'manifests');
      t.contains(out.stdout, 'e2e-web.local.test', 'manifests');
    },
  });

  runner.add({
    id: 'config-invalid', group: 'app', needs: ['app-new'],
    title: 'an invalid config is rejected with a readable message',
    run: async (t) => {
      const dir = path.join(ws.apps, 'bad');
      fs.mkdirSync(path.join(dir, '.local'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.local', 'config.json'), JSON.stringify({
        name: 'Not_Valid', port: 'x', build: {},
      }));
      const out = t.cli(['app', 'generate-manifests'], { cwd: dir, allowFail: true });
      t.assert.notStrictEqual(out.status, 0, 'invalid config was accepted');
      t.contains(out.all, 'Invalid .local/config.json');
      t.contains(out.all, 'name');
    },
  });

  runner.add({
    id: 'config-secret-env-overlap', group: 'app', needs: ['app-new'],
    title: 'a key in both "env" and "secrets" is rejected',
    run: async (t) => {
      const dir = path.join(ws.apps, 'overlap');
      fs.mkdirSync(path.join(dir, '.local'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.local', 'config.json'), JSON.stringify({
        name: 'overlap', port: 3000, build: {}, env: { TOKEN: 'a' }, secrets: ['TOKEN'],
      }));
      const out = t.cli(['app', 'generate-manifests'], { cwd: dir, allowFail: true });
      t.assert.notStrictEqual(out.status, 0);
      t.contains(out.all, "can't be in both");
    },
  });

  runner.add({
    id: 'registry-info', group: 'app', needs: ['app-new'],
    title: '"registry-info" prints the project registry addresses as JSON',
    run: async (t) => {
      const info = JSON.parse(t.cli(['app', 'registry-info'], { cwd: appDir }).stdout);
      t.assert.strictEqual(info.pushHost, `localhost:${runner.shared.ports.registryPort}`);
      t.assert.strictEqual(info.clusterHost, `${CLUSTER}-registry:5000`);
    },
  });

  // ---- hosts file ------------------------------------------------------------------------
  runner.add({
    id: 'hosts', group: 'hosts', title: 'hosts sync / list / clear manage only their own block',
    run: async (t) => {
      fs.writeFileSync(path.join(ws.home, 'apps.json'), JSON.stringify({ 'e2e-web': true }));
      t.cli(['hosts', 'sync']);
      let hosts = fs.readFileSync(ws.hostsFile, 'utf8');
      t.contains(hosts, '127.0.0.1 e2e-web.local.test', 'hosts file');
      t.contains(hosts, 'must survive', 'hosts file (original lines)');
      t.contains(t.cli(['hosts', 'list']).stdout, 'e2e-web.local.test');
      t.cli(['hosts', 'clear']);
      hosts = fs.readFileSync(ws.hostsFile, 'utf8');
      t.assert.ok(!hosts.includes('local.test'), 'managed block still present after clear');
      t.contains(hosts, 'must survive', 'hosts file (original lines)');
    },
  });

  // ---- projects --------------------------------------------------------------------------
  runner.add({
    id: 'profiles-offline', group: 'projects', title: 'profiles list/status read the project registry',
    run: async (t) => {
      const list = t.cli(['profiles', 'list']).stdout;
      t.contains(list, PROFILE, 'profiles list');
      t.contains(list, CLUSTER, 'profiles list');
      t.contains(list, 'down', 'profiles list (cluster not created yet)');
      t.contains(t.cli(['profiles', 'status']).stdout, CLUSTER, 'profiles status');
    },
  });

  runner.add({
    id: 'project-resolution', group: 'projects', needs: ['app-new'],
    title: 'an app resolves its project from the nearest .local/project.json',
    run: async (t) => {
      const out = t.cli(['app', 'registry-info'], { cwd: appDir });
      t.contains(out.stdout, String(runner.shared.ports.registryPort), 'registry-info');
    },
  });

  // ---- environment check -----------------------------------------------------------------
  runner.add({
    id: 'doctor', group: 'doctor', title: '"doctor" reports on the environment',
    run: async (t) => {
      const out = t.cli(['doctor']);
      t.contains(out.all, 'container engine available');
      t.contains(out.all, 'k3d installed');
      t.contains(out.all, 'kubectl installed');
    },
  });

  // ---- pure logic, run in this process ---------------------------------------------------
  runner.add({
    id: 'unit-distro-detection', group: 'unit', title: 'Linux distro families resolve from os-release',
    run: async (t) => {
      const cases = {
        'ID=ubuntu\nID_LIKE=debian': 'debian',
        'ID=pop\nID_LIKE="ubuntu debian"': 'debian',
        'ID=fedora': 'rhel',
        'ID="rocky"\nID_LIKE="rhel centos fedora"': 'rhel',
        'ID=manjaro\nID_LIKE=arch': 'arch',
        'ID="opensuse-leap"\nID_LIKE="suse opensuse"': 'suse',
        'ID=alpine': 'alpine',
        'ID=nixos': 'unknown',
      };
      const realRead = fs.readFileSync;
      const distro = require(path.join(SRC, 'lib', 'linuxDistro'));
      try {
        Object.entries(cases).forEach(([osRelease, family]) => {
          fs.readFileSync = (p, ...a) => (p === '/etc/os-release' ? osRelease : realRead(p, ...a));
          t.assert.strictEqual(distro.detectDistro().family, family, `os-release ${JSON.stringify(osRelease)}`);
        });
      } finally {
        fs.readFileSync = realRead;
      }
      // Docker's script mis-handles Rocky/Alma (no .../linux/rocky repo): they use the CentOS repo.
      const rocky = distro.dockerInstallSteps('rhel', 'rocky').join(' | ');
      t.contains(rocky, 'linux/centos/docker-ce.repo', 'rocky steps');
      t.assert.ok(!rocky.includes('get.docker.com'), 'rocky must not use the convenience script');
      t.assert.ok(distro.dockerInstallSteps('rhel', 'fedora')[0].includes('get.docker.com'), 'fedora keeps the script');
      t.assert.strictEqual(distro.dockerInstallSteps('alpine'), null);
      t.assert.ok(distro.dockerInstallSteps('debian')[0].includes('get.docker.com'));
    },
  });

  runner.add({
    id: 'unit-k3d-config', group: 'unit', title: 'new clusters disable metrics-server but keep servicelb',
    run: async (t) => {
      const { buildK3dConfig } = require(path.join(SRC, 'lib', 'clusterProvision'));
      const cfg = buildK3dConfig({ clusterName: 'x', httpPort: 80, httpsPort: 443, registryName: 'x-registry' });
      const args = cfg.options.k3s.extraArgs.map((a) => a.arg);
      t.assert.ok(args.includes('--disable=metrics-server'), 'metrics-server not disabled');
      t.assert.ok(!args.some((a) => a.includes('servicelb')), 'servicelb must stay enabled (it opens :80/:443)');
      t.assert.deepStrictEqual(cfg.ports.map((p) => p.port), ['80:80', '443:443']);
    },
  });

  runner.add({
    id: 'unit-command-exists', group: 'unit', title: 'commandExists works without `which`',
    run: async (t) => {
      const { commandExists } = require(path.join(SRC, 'lib', 'exec'));
      t.assert.strictEqual(commandExists('node'), true);
      t.assert.strictEqual(commandExists('definitely-not-a-real-command-xyz'), false);
    },
  });

  runner.add({
    id: 'unit-kubeconfig-missing-context', group: 'unit',
    title: 'a cluster missing from the kubeconfig asks k3d to re-add it instead of failing',
    run: async (t) => {
      // Fake k3d on PATH: records the call and writes the context, like `kubeconfig merge` would.
      const bin = path.join(ws.root, 'fake-k3d');
      const kc = path.join(ws.root, 'kubeconfig-missing');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(kc, 'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n');
      fs.writeFileSync(path.join(bin, 'k3d'), [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_K3D_LOG"',
        'kubectl config set-cluster k3d-fx --server=https://127.0.0.1:1',
        'kubectl config set-credentials u',
        'kubectl config set-context k3d-fx --cluster=k3d-fx --user=u',
        '',
      ].join('\n'));
      fs.chmodSync(path.join(bin, 'k3d'), 0o755);
      const log = path.join(ws.root, 'fake-k3d.log');
      const env = { ...t.env, KUBECONFIG: kc, FAKE_K3D_LOG: log, PATH: `${bin}${path.delimiter}${t.env.PATH}` };
      t.sh(process.execPath, ['-e',
        `require(${JSON.stringify(path.join(SRC, 'lib', 'clusterProvision'))}).useClusterContext('fx');`], { env });
      t.contains(fs.readFileSync(log, 'utf8'), 'kubeconfig merge fx', 'k3d calls');
      t.contains(t.sh('kubectl', ['config', 'current-context'], { env }).stdout, 'k3d-fx', 'current context');
    },
  });

  runner.add({
    id: 'unit-kubeconfig-fix', group: 'unit', title: 'a 0.0.0.0 API server in kubeconfig is rewritten to 127.0.0.1',
    run: async (t) => {
      // Runs the real helper against a scratch kubeconfig, never your own.
      const kc = path.join(ws.root, 'kubeconfig-unit');
      fs.writeFileSync(kc, [
        'apiVersion: v1', 'kind: Config', 'current-context: k3d-unit',
        'clusters:', '- name: k3d-unit', '  cluster: {server: "https://0.0.0.0:6443"}',
        'contexts:', '- name: k3d-unit', '  context: {cluster: k3d-unit, user: u}',
        'users:', '- name: u', '  user: {}', '',
      ].join('\n'));
      const out = t.sh(process.execPath, ['-e',
        `require(${JSON.stringify(path.join(SRC, 'lib', 'clusterProvision'))}).useClusterContext('unit');`
        + "console.log(require('child_process').execFileSync('kubectl',['config','view','--minify','-o','jsonpath={.clusters[0].cluster.server}'],{encoding:'utf8'}));",
      ], { env: { ...t.env, KUBECONFIG: kc } });
      t.contains(out.stdout, 'https://127.0.0.1:6443', 'kubeconfig server');
    },
  });
};
