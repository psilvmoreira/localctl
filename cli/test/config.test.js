// Offline tests for the YAML config: no cluster, no Helm, nothing outside a temp folder.
// Run with `npm test` (node --test).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readRawConfig } = require('../src/lib/loadConfig');
const { appConfigSchema, describeIssues } = require('../src/lib/configSchema');
const { readEnvFile, parseEnvFile } = require('../src/lib/envFile');
const { applyResources } = require('../src/lib/addonLoader');
const { generateManifests } = require('../src/lib/manifestGen');
const { tiltConfig } = require('../src/lib/tiltConfig');

// Symlinks, FIFOs and `#!/bin/sh` fake tools only work on POSIX systems; the CI also runs on Windows.
const POSIX = process.platform !== 'win32';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localctl-config-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function parse(yamlText) {
  const dir = fs.mkdtempSync(path.join(tmp, 'app-'));
  fs.mkdirSync(path.join(dir, '.local'));
  const file = path.join(dir, '.local', 'config.yaml');
  fs.writeFileSync(file, yamlText);
  return appConfigSchema.safeParse(readRawConfig(file));
}
const issues = (r) => describeIssues(r.error.issues);
const MIN = 'name: a\nport: 80\nbuild: {}\n';

test('scalars in env become strings, empty values become empty strings', () => {
  const r = parse(`${MIN}env:\n  PORT: 3000\n  DEBUG: true\n  EMPTY:\n`);
  assert.deepStrictEqual(r.data.env, { PORT: '3000', DEBUG: 'true', EMPTY: '' });
});

test('empty keys fall back to defaults, in sidecars too', () => {
  const r = parse(`${MIN}secrets:\nsidecars:\n  - name: s\n    image: x\n    env:\n`);
  assert.ok(r.success, r.success ? '' : issues(r));
  assert.deepStrictEqual(r.data.sidecars[0].env, {});
});

test('unknown fields are rejected with a suggestion', () => {
  const r = parse('name: a\nport: 80\nreplica: 3\nbuild:\n  dockerfil: x\n');
  assert.ok(!r.success);
  assert.match(issues(r), /unknown field "replica" - did you mean "replicas"\?/);
  assert.match(issues(r), /build: unknown field "dockerfil" - did you mean "dockerfile"\?/);
});

test('invalid YAML and a legacy config.json give actionable errors', () => {
  assert.throws(() => parse('name: [oops'), /not valid YAML/);
  const dir = fs.mkdtempSync(path.join(tmp, 'legacy-'));
  fs.mkdirSync(path.join(dir, '.local'));
  fs.writeFileSync(path.join(dir, '.local', 'config.json'), '{}');
  assert.throws(() => readRawConfig(path.join(dir, '.local', 'config.yaml')), /config\.json.*now reads \.local\/config\.yaml/);
  assert.throws(() => readRawConfig(path.join(tmp, 'nothing', 'config.yaml')), /No config found/);
});

test('ports, names and run steps are validated', () => {
  assert.match(issues(parse('name: a\nport: 0\nbuild: {}\n')), /port/);
  assert.match(issues(parse('name: a\nport: 99999999999999999999\nbuild: {}\n')), /port/);
  assert.match(issues(parse('name: -x\nport: 80\nbuild: {}\n')), /name/);
  assert.match(issues(parse(`${MIN}namespace: "--kubeconfig=./evil"\n`)), /namespace/);
  assert.match(issues(parse(`${MIN}run:\n  - command: npm i\n`)), /at least one "sync" entry/);
});

test('dependency fields cannot inject Helm values', () => {
  const evil = 'storage: "1Gi\\"\\n  extraVolumes: [x]\\nx: \\""';
  assert.match(issues(parse(`${MIN}dependencies:\n  - type: postgres\n    ${evil}\n`)), /storage/);
  const ok = parse(`${MIN}dependencies:\n  - type: postgres\n    version: 16.1\n    database: orders\n    storage: 2Gi\n`);
  assert.ok(ok.success, ok.success ? '' : issues(ok));
  assert.strictEqual(ok.data.dependencies[0].version, '16.1');
});

test('command, args and build options reach the manifest and the Tilt config', () => {
  const r = parse(`${MIN.replace('build: {}', 'build:\n  target: dev\n  args: {NODE: 20}\n  ignore: [node_modules]')}command: [npm]\nargs: [run, dev]\nsync:\n  - {localPath: ., remotePath: /a}\nrun:\n  - {command: npm i, trigger: [package.json]}\n`);
  assert.ok(r.success, r.success ? '' : issues(r));
  const cfg = { ...r.data, namespace: 'a', subdomain: 'a' };
  const manifest = generateManifests(cfg);
  assert.match(manifest, /command:\n\s+- npm/);
  assert.match(manifest, /args:\n\s+- run\n\s+- dev/);
  const tilt = tiltConfig(cfg);
  assert.strictEqual(tilt.build.target, 'dev');
  assert.deepStrictEqual(tilt.build.args, { NODE: '20' });
  assert.deepStrictEqual(tilt.run, [{ command: 'npm i', trigger: ['package.json'] }]);
  assert.deepStrictEqual(tilt.portForwards, ['80:80']);
});

test('envFile parses dotenv lines and stays inside the app folder', () => {
  assert.deepStrictEqual(parseEnvFile('# c\nA=1\nexport B="x y"\nC=z # note\nD=\'q\'\n'), { A: '1', B: 'x y', C: 'z', D: 'q' });
  assert.throws(() => parseEnvFile('not a pair'), /line 1/);
  const app = path.join(tmp, 'envapp');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(tmp, 'outside'), 'TOKEN=secret\n');
  if (POSIX) fs.symlinkSync(path.join(tmp, 'outside'), path.join(app, 'link.env'));
  assert.deepStrictEqual(readEnvFile(app, '.env'), { A: '1' });
  assert.throws(() => readEnvFile(app, '../outside'), /outside the app folder/);
  if (POSIX) assert.throws(() => readEnvFile(app, 'link.env'), /outside the app folder/);
  assert.throws(() => readEnvFile(app, path.join(tmp, 'outside')), /outside the app folder/);
  assert.throws(() => readEnvFile(app, 'missing.env'), /not found/);
});

test('dependency resources are written into the addon values', () => {
  const values = {};
  applyResources(values, 'primary.resources', { limits: { memory: '256Mi' } }, 'postgres');
  assert.deepStrictEqual(values, { primary: { resources: { limits: { memory: '256Mi' } } } });
  assert.throws(() => applyResources({}, undefined, {}, 'kafka'), /no "resourcesPath"/);
  assert.throws(() => applyResources({}, '__proto__.x', {}, 'kafka'), /Invalid resourcesPath/);
  assert.strictEqual({}.x, undefined);
});

test('the shipped examples validate', () => {
  for (const name of ['dotnet-api', 'node-app', 'python-app']) {
    const file = path.join(__dirname, '..', '..', 'examples', name, '.local', 'config.yaml');
    const r = appConfigSchema.safeParse(readRawConfig(file));
    assert.ok(r.success, `${name}: ${r.success ? '' : issues(r)}`);
  }
});

// ---- ports, ingress, volumes, init containers, probes, security context, environments ----

const yamlLib = require('js-yaml');
const { applyEnvironment } = require('../src/lib/loadConfig');
const { assertNamespaceOwnership, ensureManagedNamespace } = require('../src/lib/namespaces');
const { setSecret, unsetSecret } = require('../src/lib/appSecrets');

function manifestsFor(yamlText) {
  const r = parse(yamlText);
  assert.ok(r.success, r.success ? '' : issues(r));
  const cfg = { ...r.data, namespace: r.data.name, subdomain: r.data.name, hosts: [r.data.name, ...r.data.ingress.hosts] };
  const docs = yamlLib.loadAll(generateManifests(cfg)).filter(Boolean);
  const byKind = (kind) => docs.find((d) => d.kind === kind);
  return { cfg, deployment: byKind('Deployment'), service: byKind('Service'), ingress: byKind('Ingress') };
}

test('extra ports, ingress hosts/paths and annotations render', () => {
  const { deployment, service, ingress, cfg } = manifestsFor(`${MIN}ports:
  - {port: 9090, name: metrics, forward: true}
  - {port: 5353, protocol: UDP}
ingress:
  hosts: [api]
  paths: [{path: /api, port: 9090}, {path: /}]
  annotations: {traefik.ingress.kubernetes.io/service.passhostheader: "true"}
`);
  const container = deployment.spec.template.spec.containers[0];
  assert.deepStrictEqual(container.ports.map((p) => [p.name, p.containerPort, p.protocol || 'TCP']), [['http', 80, 'TCP'], ['metrics', 9090, 'TCP'], ['p5353-udp', 5353, 'UDP']]);
  assert.deepStrictEqual(service.spec.ports.map((p) => p.port), [80, 9090, 5353]);
  assert.deepStrictEqual(ingress.spec.rules.map((r) => r.host), ['a.local.test', 'api.local.test']);
  assert.deepStrictEqual(ingress.spec.rules[0].http.paths.map((p) => [p.path, p.backend.service.port.number]), [['/api', 9090], ['/', 80]]);
  assert.strictEqual(ingress.metadata.annotations['traefik.ingress.kubernetes.io/service.passhostheader'], 'true');
  assert.strictEqual(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.entrypoints'], 'websecure');
  assert.deepStrictEqual(ingress.spec.tls[0].hosts, ['a.local.test', 'api.local.test']);
  assert.deepStrictEqual(tiltConfig(cfg).portForwards, ['80:80', '9090:9090']);
});

test('volumes, init containers, probes, labels and security context render', () => {
  const { deployment } = manifestsFor(`${MIN}volumes:
  - {name: cache, mountPath: /var/cache/app, sizeLimit: 256Mi}
initContainers:
  - {name: migrate, command: [npm, run, migrate], env: {STEP: 1}}
probes:
  readiness: {path: /ready, timeoutSeconds: 3, failureThreshold: 5}
  liveness: {command: [cat, /tmp/ok]}
  startup: {path: /healthz, failureThreshold: 30}
labels: {team: core}
annotations: {note: hello}
imagePullPolicy: IfNotPresent
terminationGracePeriodSeconds: 5
securityContext: {runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true}
`);
  const pod = deployment.spec.template.spec;
  const main = pod.containers[0];
  assert.deepStrictEqual(pod.volumes, [{ name: 'cache', emptyDir: { sizeLimit: '256Mi' } }]);
  assert.deepStrictEqual(main.volumeMounts, [{ name: 'cache', mountPath: '/var/cache/app' }]);
  assert.strictEqual(pod.initContainers[0].image, 'a');
  assert.deepStrictEqual(pod.initContainers[0].env, [{ name: 'STEP', value: '1' }]);
  assert.strictEqual(main.readinessProbe.httpGet.path, '/ready');
  assert.strictEqual(main.readinessProbe.timeoutSeconds, 3);
  assert.deepStrictEqual(main.livenessProbe.exec.command, ['cat', '/tmp/ok']);
  assert.strictEqual(main.startupProbe.failureThreshold, 30);
  assert.deepStrictEqual(deployment.spec.template.metadata.labels, { team: 'core', app: 'a' });
  assert.deepStrictEqual(deployment.spec.selector.matchLabels, { app: 'a' });
  assert.strictEqual(deployment.spec.template.metadata.annotations.note, 'hello');
  assert.strictEqual(main.imagePullPolicy, 'IfNotPresent');
  assert.strictEqual(pod.terminationGracePeriodSeconds, 5);
  assert.deepStrictEqual(main.securityContext, { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true });
});

test('unsafe or inconsistent settings are rejected', () => {
  const bad = (extra, pattern) => assert.match(issues(parse(MIN + extra)), pattern, extra);
  bad('securityContext: {privileged: true}\n', /unknown field "privileged"/);
  bad('securityContext: {capabilities: {add: [SYS_ADMIN]}}\n', /unknown field "capabilities"/);
  bad('volumes:\n  - {name: v, mountPath: /x, hostPath: /etc}\n', /unknown field "hostPath"/);
  bad('volumes:\n  - {name: v, mountPath: /a/../etc}\n', /mountPath/);
  bad('volumes:\n  - {name: v, mountPath: /}\n', /mountPath/);
  bad('ingress:\n  annotations: {nginx.ingress.kubernetes.io/server-snippet: "x"}\n', /not an allowed annotation/);
  bad('ingress:\n  annotations: {traefik.ingress.kubernetes.io/router.priority: "100000"}\n', /not an allowed annotation/);
  bad('ingress:\n  annotations: {traefik.ingress.kubernetes.io/router.middlewares: other-x@kubernetescrd}\n', /not an allowed annotation/);
  bad('ingress:\n  paths: [{path: "/a b"}]\n', /path/);
  bad('ingress:\n  paths: [{path: /x, port: 1234}]\n', /not "port" or a TCP entry of "ports"/);
  bad('ingress:\n  hosts: [a]\n', /different from the main subdomain/);
  bad('ports:\n  - {port: 80}\n', /already used/);
  bad('labels: {app: other}\n', /reserved/);
  bad('annotations: {localctl.dev/managed: "false"}\n', /reserved/);
  bad('initContainers:\n  - {name: wait-for-db}\n', /reserved/);
  bad('initContainers:\n  - {name: a}\n', /used more than once/);
  bad('probes:\n  readiness: {path: /x, command: [cat]}\n', /either "path"/);
  bad('terminationGracePeriodSeconds: 99999\n', /terminationGracePeriodSeconds/);
});

test('environments merge over the base config and cannot change identity', () => {
  const raw = {
    name: 'a', port: 80, build: {}, env: { LOG: 'info', KEEP: 'x' }, replicas: 1, sync: [{ localPath: '.', remotePath: '/a' }],
    environments: {
      prod: { env: { LOG: 'warn', PORT: 8080 }, replicas: 3, sync: [] },
      bad: { name: 'other' },
      pollute: JSON.parse('{"__proto__": {"polluted": true}, "replicas": 2}'),
    },
  };
  assert.strictEqual(applyEnvironment(raw, '').environments, undefined);
  const prod = applyEnvironment(raw, 'prod');
  assert.deepStrictEqual(prod.env, { LOG: 'warn', KEEP: 'x', PORT: '8080' });
  assert.strictEqual(prod.replicas, 3);
  assert.deepStrictEqual(prod.sync, []);
  assert.strictEqual(prod.environments, undefined);
  assert.throws(() => applyEnvironment(raw, 'nope'), /Unknown environment "nope".*prod, bad, pollute/);
  assert.throws(() => applyEnvironment(raw, 'bad'), /can't override "name"/);
  assert.throws(() => applyEnvironment(raw, 'pollute'), /reserved key/);
  assert.strictEqual({}.polluted, undefined);
  assert.throws(() => applyEnvironment({ name: 'a', environments: { Prod: {} } }, 'Prod'), /Environment name/);
  assert.throws(() => applyEnvironment({ name: 'a' }, 'x'), /no "environments" block/);
  assert.ok(appConfigSchema.safeParse(prod).success);
});

// ---- regression tests for issues found by the security review and the red-team run ----

test('namespaces owned by Kubernetes or localctl are refused', () => {
  for (const ns of ['kube-system', 'default', 'observability']) {
    assert.match(issues(parse(`${MIN}namespace: ${ns}\n`)), /reserved/, ns);
  }
  assert.match(issues(parse('name: default\nport: 80\nbuild: {}\n')), /reserved/);
  assert.match(issues(parse(`name: ${'a'.repeat(64)}\nport: 80\nbuild: {}\n`)), /at most 63/);
});

test('pod annotations cannot weaken confinement', () => {
  for (const key of ['container.apparmor.security.beta.kubernetes.io/a', 'seccomp.security.alpha.kubernetes.io/pod', 'io.kubernetes.cri-o.Devices', 'k8s.v1.cni.cncf.io/networks']) {
    assert.match(issues(parse(`${MIN}annotations: {${key}: x}\n`)), /not allowed/, key);
  }
  assert.ok(parse(`${MIN}annotations: {prometheus.io/scrape: "true"}\n`).success);
});

test('build and sync paths must stay relative', () => {
  for (const bad of ['/', '/etc', '~/.ssh', 'C:/x']) {
    assert.match(issues(parse(`name: a\nport: 80\nbuild: {context: "${bad}"}\n`)), /relative path/, bad);
  }
  // Backslash forms can't be written easily in a YAML string, so check the schema directly.
  for (const bad of ['C:\\x', '\\\\server\\share']) {
    const r = appConfigSchema.safeParse({ name: 'a', port: 80, build: { context: bad } });
    assert.ok(!r.success && /relative path/.test(issues(r)), bad);
  }
  assert.match(issues(parse(`${MIN}sync: [{localPath: "~/.ssh", remotePath: /a}]\n`)), /relative path/);
  assert.match(issues(parse('name: a\nport: 80\nbuild: {dockerfile: /etc/passwd}\n')), /relative path/);
  assert.ok(parse('name: a\nport: 80\nbuild: {context: ../shared}\n').success);
  assert.match(issues(parse('name: a\nport: 80\nbuild: {target: --network=host}\n')), /target/);
});

test('mount paths are normalised and system paths refused', () => {
  for (const mp of ['//', '/.', '/./', '/a/./b', '/a//b', '/d/', '/proc', '/proc/x', '/sys', '/dev/null', '/var/run/secrets/kubernetes.io/serviceaccount']) {
    assert.match(issues(parse(`${MIN}volumes: [{name: v, mountPath: "${mp}"}]\n`)), /mountPath/, mp);
  }
  assert.ok(parse(`${MIN}volumes: [{name: v, mountPath: /var/cache/app}]\n`).success);
});

test('security context cannot ask for more privilege', () => {
  assert.match(issues(parse(`${MIN}securityContext: {allowPrivilegeEscalation: true}\n`)), /allowPrivilegeEscalation/);
  assert.match(issues(parse(`${MIN}securityContext: {runAsNonRoot: true, runAsUser: 0}\n`)), /contradicts/);
  assert.ok(parse(`${MIN}securityContext: {allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 1000}\n`).success);
});

test('names, ports and images cannot collide or look like flags', () => {
  assert.match(issues(parse(`${MIN}sidecars: [{name: wait-for-postgres, image: x}]\n`)), /reserved/);
  assert.match(issues(parse(`${MIN}sidecars: [{name: s, image: x, port: 80}]\n`)), /already used/);
  assert.match(issues(parse(`${MIN}ports: [{port: 81, name: http}]\n`)), /already used/);
  assert.match(issues(parse(`${MIN}ports: [{port: 81, name: p82}, {port: 82}]\n`)), /already used/);
  assert.match(issues(parse(`${MIN}debug: {enabled: true, port: 9229}\nports: [{port: 9229}]\n`)), /already used/);
  assert.match(issues(parse(`${MIN}sidecars: [{name: s, image: "--privileged"}]\n`)), /image/);
  assert.match(issues(parse(`${MIN}initContainers: [{name: i, image: "x y"}]\n`)), /image/);
  assert.match(issues(parse(`${MIN}labels: {"${'k'.repeat(64)}": v}\n`)), /63/);
});

test('quantities, sizes and URL paths are strict', () => {
  assert.match(issues(parse(`${MIN}resources: {limits: {memory: banana}}\n`)), /memory "banana"/);
  assert.ok(parse(`${MIN}resources: {limits: {memory: 256Mi, cpu: 1}, requests: {cpu: 500m}}\n`).success);
  for (const storage of ['0Gi', '99999999999999999999Ti']) {
    assert.match(issues(parse(`${MIN}dependencies: [{type: postgres, storage: "${storage}"}]\n`)), /storage/, storage);
  }
  assert.match(issues(parse(`${MIN}dependencies: [{type: postgres, database: ${'d'.repeat(64)}}]\n`)), /database/);
  assert.match(issues(parse(`${MIN}volumes: [{name: v, mountPath: /x, sizeLimit: 0Mi}]\n`)), /sizeLimit/);
  for (const p of ['/../x', '//', '/%0d%0a', '/a//b', `/${'a'.repeat(300)}`]) {
    assert.match(issues(parse(`${MIN}ingress: {paths: [{path: "${p}"}]}\n`)), /path/, p);
  }
  assert.match(issues(parse(`${MIN}probes: {readiness: {path: "//evil.com"}}\n`)), /path/);
  assert.match(issues(parse(`${MIN}probes: {readiness: {command: [""]}}\n`)), /command/);
});

test('scalars that look like numbers or dates keep their exact text', () => {
  const env = parse(`${MIN}env:
  BIG: 12345678901234567890
  EXP: 1e3
  HEX: 0x10
  OCT: 0777
  VER: 1.10
  PLUS: +1
  INF: .inf
  DATE: 2001-12-14
  PORT: 3000
  RATIO: 0.5
  NEG: -2
  FLAG: true
`).data.env;
  assert.deepStrictEqual(env, {
    BIG: '12345678901234567890', EXP: '1e3', HEX: '0x10', OCT: '0777', VER: '1.10', PLUS: '+1', INF: '.inf', DATE: '2001-12-14',
    PORT: '3000', RATIO: '0.5', NEG: '-2', FLAG: 'true',
  });
});

test('the strict YAML loader keeps structure features and rejects unsafe ones', () => {
  const { loadYaml } = require('../src/lib/yamlLoad');
  assert.deepStrictEqual(loadYaml('a: &x {q: 0x10}\nb:\n  <<: *x\n  r: 5\n'), { a: { q: '0x10' }, b: { q: '0x10', r: 5 } });
  assert.deepStrictEqual(loadYaml('p: 3000\nf: 0.5\nn: ~\nb: false\ns: !!str 5\ny: yes\n'), { p: 3000, f: 0.5, n: null, b: false, s: '5', y: 'yes' });
  assert.throws(() => loadYaml('a: 1\na: 2\n'), /duplicated mapping key/);
  assert.throws(() => loadYaml('x: !!js/function "function(){}"'), /unknown tag/);
  assert.throws(() => loadYaml('a: 1\n---\nb: 2\n'), /multiple documents|expected a single document/);
  // a number field still needs a real number
  assert.match(issues(parse('name: a\nport: "3000"\nbuild: {}\n')), /port/);
  assert.match(issues(parse('name: a\nport: 0x50\nbuild: {}\n')), /port/);
});

test('overlay lists get the same env clean-up as the base file', () => {
  const raw = { name: 'a', port: 80, build: {}, environments: { e: { sidecars: [{ name: 's', image: 'x', env: { N: 1 } }] } } };
  const merged = applyEnvironment(raw, 'e');
  assert.deepStrictEqual(merged.sidecars[0].env, { N: '1' });
  assert.ok(appConfigSchema.safeParse(merged).success);
});

test('alias bombs, oversized files and self-referencing anchors are refused fast', () => {
  const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]'];
  let prev = 'a';
  for (const n of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) {
    bomb.push(`${n}: &${n} [${Array(9).fill(`*${prev}`).join(', ')}]`);
    prev = n;
  }
  const started = Date.now();
  assert.throws(() => parse(`${MIN}x-bomb: 1\n${bomb.join('\n')}\n`), /far larger|too many YAML aliases/);
  assert.ok(Date.now() - started < 6000, 'must be refused quickly');
  assert.throws(() => parse(`${MIN}# ${'x'.repeat(600 * 1024)}\n`), /larger than/);
});

test('envFile refuses pipes, hard links, directories and huge files', () => {
  const app = fs.mkdtempSync(path.join(tmp, 'envsafe-'));
  const outside = path.join(tmp, 'outside-secret');
  fs.writeFileSync(outside, 'SECRET=s\n');
  fs.linkSync(outside, path.join(app, 'hard.env'));
  assert.throws(() => readEnvFile(app, 'hard.env'), /hard links/);
  fs.mkdirSync(path.join(app, 'dir'));
  assert.throws(() => readEnvFile(app, 'dir'), /not a regular file/);
  fs.writeFileSync(path.join(app, 'big.env'), `A=${'x'.repeat(300 * 1024)}\n`);
  assert.throws(() => readEnvFile(app, 'big.env'), /larger than/);
  if (process.platform !== 'win32') {
    require('child_process').execFileSync('mkfifo', [path.join(app, 'pipe.env')]);
    assert.throws(() => readEnvFile(app, 'pipe.env'), /not a regular file/);
  }
});

test('namespace guard refuses namespaces it does not own (kubectl is faked)', { skip: !POSIX }, () => {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh
# Fake kubectl: prints $FAKE_NS_JSON for "get namespace ... -o json", fails when it is empty.
[ -n "$FAKE_NS_JSON" ] && printf '%s' "$FAKE_NS_JSON" && exit 0
[ -n "$FAKE_NS_ERROR" ] && echo "$FAKE_NS_ERROR" >&2 && exit 1
echo 'Error from server (NotFound): namespaces "shop" not found' >&2
exit 1
`, { mode: 0o755 });
  const { assertNamespaceOwnership } = require('../src/lib/namespaces');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const cfg = { name: 'orders', namespace: 'shop' };
  const check = (json) => { process.env.FAKE_NS_JSON = json; try { assertNamespaceOwnership(cfg); } finally { delete process.env.FAKE_NS_JSON; } };
  try {
    check('');                                                                                    // does not exist yet: fine
    check(JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' }, annotations: { 'localctl.dev/app': 'orders' } } })); // ours
    assert.throws(() => check(JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' } } })), /no owner recorded/);
    assert.throws(() => check('null'), /Couldn't read namespace/);                                // odd output is an error, not a pass
    assert.throws(() => check('[]'), /Couldn't read namespace/);
    assert.throws(() => check('not json'), /Couldn't read namespace/);
    process.env.FAKE_NS_ERROR = 'The connection to the server 127.0.0.1:1 was refused';
    assert.throws(() => check(''), /Couldn't check whether namespace "shop" is yours/);   // API down: fail closed
    delete process.env.FAKE_NS_ERROR;
    assert.throws(() => check(JSON.stringify({ metadata: { labels: {} } })), /wasn't created by localctl/);
    assert.throws(() => check(JSON.stringify({ metadata: { name: 'kube-system' } })), /wasn't created by localctl/);
    assert.throws(
      () => check(JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' }, annotations: { 'localctl.dev/app': 'billing' } } })),
      /belongs to the app "billing"/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test('generated Namespace is marked as managed and owned by the app', () => {
  const { manifest } = (() => { const r = manifestsFor(MIN); return { manifest: r }; })();
  const docs = yamlLib.loadAll(generateManifests({ ...manifest.cfg, namespace: 'a', subdomain: 'a' })).filter(Boolean);
  const ns = docs.find((d) => d.kind === 'Namespace');
  assert.strictEqual(ns.metadata.labels['localctl.dev/managed'], 'true');
  assert.strictEqual(ns.metadata.annotations['localctl.dev/app'], 'a');
});

test('env names, list sizes, duplicate dependencies and release-name length are checked', () => {
  for (const key of ['A=B', 'has space', '-lead', 'ünï', '""']) {
    assert.match(issues(parse(`${MIN}env: {${JSON.stringify(key)}: x}\n`)), /environment variable name/, key);
  }
  assert.match(issues(parse(`${MIN}sidecars: [{name: s, image: x, env: {"a b": c}}]\n`)), /environment variable name/);
  assert.match(issues(parse(`${MIN}replicas: 21\n`)), /replicas/);
  const many = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join(', ');
  assert.match(issues(parse(`${MIN}ingress: {hosts: [${many(21, (i) => `h${i}`)}]}\n`)), /at most 20/);
  assert.match(issues(parse(`${MIN}ports: [${many(21, (i) => `{port: ${2000 + i}}`)}]\n`)), /at most 20/);
  assert.match(issues(parse(`${MIN}dependencies: [{type: redis}, {type: redis}]\n`)), /once per app/);
  assert.match(issues(parse(`name: ${'a'.repeat(50)}\nport: 80\nbuild: {}\ndependencies: [{type: postgres}]\n`)), /53 characters/);
});

test('app secrets are stored as base64 data via create/replace, never apply (kubectl is faked)', { skip: !POSIX }, () => {
  const bin = fs.mkdtempSync(path.join(tmp, 'sbin-'));
  const log = path.join(bin, 'log');
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"get namespace"*) printf '%s' '{"metadata":{"labels":{"localctl.dev/managed":"true"},"annotations":{"localctl.dev/app":"orders"}}}'; exit 0;;
  *"get secret"*) printf '%s' '{"metadata":{"resourceVersion":"3","labels":{"localctl.dev/managed":"true"}},"data":{"BIN":"//4A","KEEP":"a2VlcA=="}}'; exit 0;;
  *"replace -f -"*|*"create -f -"*) cat >> "${log}.stdin"; echo >> "${log}.stdin"; exit 0;;
esac
exit 0
`, { mode: 0o755 });
  const { setSecret, unsetSecret } = require('../src/lib/appSecrets');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    setSecret({ name: 'orders', namespace: 'shop' }, 'NEW', 'v1');
    unsetSecret({ name: 'orders', namespace: 'shop' }, 'KEEP');
    assert.throws(() => setSecret({ name: 'orders', namespace: 'shop' }, '__proto__', 'x'), /not a valid secret name/);
    assert.throws(() => setSecret({ name: 'orders', namespace: 'shop' }, '--from-file=/etc/passwd', 'x'), /not a valid secret name/);
  } finally {
    process.env.PATH = oldPath;
  }
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(!/\bapply\b/.test(calls), 'must not use kubectl apply for Secrets');
  const sent = fs.readFileSync(`${log}.stdin`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(sent[0].data, { BIN: '//4A', KEEP: 'a2VlcA==', NEW: Buffer.from('v1').toString('base64') }); // binary value untouched
  assert.deepStrictEqual(sent[1].data, { BIN: '//4A' });                                                          // unset really drops the key
  assert.strictEqual(sent[0].stringData, undefined);
});

// ---- regression tests for red-team round 2 ----

const { assertPathsInsideProject } = require('../src/lib/pathGuard');
const { readRegularFile } = require('../src/lib/safeRead');

test('build and sync paths cannot climb out of the repository', () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const app = path.join(repo, 'apps', 'a');
  fs.mkdirSync(app, { recursive: true });
  const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
  if (POSIX) fs.symlinkSync(outside, path.join(app, 'escape'));
  const cfg = (context, extra = {}) => ({ build: { context, dockerfile: 'Dockerfile', ...extra }, sync: [] });
  assert.doesNotThrow(() => assertPathsInsideProject(cfg('.'), app));
  assert.doesNotThrow(() => assertPathsInsideProject(cfg('../..'), app));               // up to the repo root: monorepo
  assert.doesNotThrow(() => assertPathsInsideProject(cfg('../shared'), app));
  assert.throws(() => assertPathsInsideProject(cfg('../../..'), app), /outside the project/);
  assert.throws(() => assertPathsInsideProject(cfg('../../../../../../etc'), app), /outside the project/);
  if (POSIX) assert.throws(() => assertPathsInsideProject(cfg('escape'), app), /outside the project/);   // symlink inside the repo
  assert.throws(() => assertPathsInsideProject({ build: { context: '.', dockerfile: '../../../x' }, sync: [] }, app), /build.dockerfile/);
  assert.throws(() => assertPathsInsideProject({ ...cfg('.'), sync: [{ localPath: '../../../..', remotePath: '/a' }] }, app), /sync.0.localPath/);
  const loose = fs.mkdtempSync(path.join(tmp, 'norepo-'));                                  // no .git: only the app folder itself
  fs.mkdirSync(path.join(loose, 'app'));
  assert.throws(() => assertPathsInsideProject(cfg('..'), path.join(loose, 'app')), /outside the project/);
});

test('dotenv parsing is linear and handles quotes before comments', () => {
  const started = Date.now();
  assert.deepStrictEqual(parseEnvFile(`A=x${' '.repeat(8000)}y\n`), { A: `x${' '.repeat(8000)}y` });
  assert.ok(Date.now() - started < 2500, 'must not be quadratic');
  assert.throws(() => parseEnvFile(`A=${'x'.repeat(9000)}\n`), /longer than/);
  assert.deepStrictEqual(parseEnvFile('B="q" # c\nC=\'w\' trailing\nD=v # note\nE=a#b\n__proto__=x\n'), { B: 'q', C: 'w', D: 'v', E: 'a#b' });
  assert.strictEqual({}.x, undefined);
});

test('one huge string aliased many times is refused, deep alias chains fail cleanly', () => {
  const big = 'x'.repeat(200 * 1024);
  const aliases = Array.from({ length: 400 }, () => '*s').join(', ');
  const started = Date.now();
  assert.throws(() => parse(`${MIN}x-big: &s "${big}"\nx-all: [${aliases}]\n`), /far larger|too many YAML aliases/);
  assert.ok(Date.now() - started < 8000);
  const chain = ['"20000": &a0 [1]'];
  for (let i = 1; i < 12000; i += 1) chain.push(`"${20000 - i}": &a${i} [*a${i - 1}]`);
  assert.throws(() => parse(`${MIN}x-chain:\n  ${chain.join('\n  ')}\n`), (e) => /^Invalid \.local\/config\.yaml/.test(e.message) && !(e instanceof RangeError));
});

test('config.yaml and envFile must be plain files (FIFO, symlink swap)', { skip: !POSIX }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fifo-'));
  fs.mkdirSync(path.join(dir, '.local'));
  require('child_process').execFileSync('mkfifo', [path.join(dir, '.local', 'config.yaml')]);
  assert.throws(() => readRawConfig(path.join(dir, '.local', 'config.yaml')), /not a regular file/);
  const real = path.join(dir, 'real.txt');
  fs.writeFileSync(real, 'A=1\n');
  fs.symlinkSync(real, path.join(dir, 'link.txt'));
  assert.strictEqual(readRegularFile(real, 1024), 'A=1\n');
  assert.throws(() => readRegularFile(path.join(dir, 'link.txt'), 1024), /symbolic link/);   // O_NOFOLLOW on the final component
  assert.throws(() => readRegularFile(real, 2), /larger than/);
});

test('runtime/mesh annotations, risky labels, system mounts and more namespaces are refused', () => {
  for (const key of ['io.katacontainers.config.hypervisor.kernel', 'cni.projectcalico.org/ipAddrs', 'sidecar.istio.io/proxyImage', 'linkerd.io/inject', 'vault.hashicorp.com/agent-inject', 'iam.amazonaws.com/role', 'io.containerd.cri.runtime-handler', 'run.oci.handler', 'io.podman.annotations.privileged', 'org.systemd.property.X', 'openshift.io/scc', 'v1.multus-cni.io/default-network']) {
    assert.match(issues(parse(`${MIN}annotations: {${key}: x}\n`)), /not allowed/, key);
  }
  for (const key of ['istio-injection', 'pod-security.kubernetes.io/enforce', 'kubernetes.io/metadata.name', 'sidecar.istio.io/inject', 'linkerd.io/inject']) {
    assert.match(issues(parse(`${MIN}labels: {${key}: x}\n`)), /not allowed/, key);
  }
  for (const mp of ['/Proc', '/SYS/fs', '/run', '/var/run', '/run/secrets/kubernetes.io/serviceaccount', '/RUN/secrets']) {
    assert.match(issues(parse(`${MIN}volumes: [{name: v, mountPath: "${mp}"}]\n`)), /mountPath/, mp);
  }
  assert.ok(parse(`${MIN}volumes: [{name: v, mountPath: /run/app}]\n`).success);
  for (const ns of ['cert-manager', 'traefik', 'kube-foo', 'localctl']) {
    assert.match(issues(parse(`${MIN}namespace: ${ns}\n`)), /reserved/, ns);
  }
  assert.match(issues(parse(`${MIN}debug: {enabled: true, port: 80}\n`)), /must differ/);
});

test('a __proto__ key in env is dropped, not turned into inherited variables', () => {
  const r = parse(`${MIN}env:\n  "__proto__": {EVIL: x}\n  REAL: 1\n`);
  assert.deepStrictEqual(Object.keys(r.data.env), ['REAL']);
  assert.strictEqual(r.data.env.EVIL, undefined);
});

// ---- remaining issues from the red-team reports ----

test('same port on TCP and UDP is fine, collisions with sidecars are caught, names avoid double dashes', () => {
  assert.ok(parse(`${MIN}ports: [{port: 5353, name: dns-udp, protocol: UDP}, {port: 5353, name: dns-tcp}]\n`).success);
  assert.match(issues(parse(`${MIN}ports: [{port: 9090, name: m}]\nsidecars: [{name: s, image: x, port: 9090}]\n`)), /already used/);
  assert.match(issues(parse(`${MIN}ports: [{port: 81, name: a--b}]\n`)), /name/);
  assert.ok(parse(`${MIN}ports: [{port: 81, name: a-b}, {port: 82, name: x}]\n`).success);
});

test('ingress annotation values are validated, not just keys', () => {
  const key = 'traefik.ingress.kubernetes.io/service.sticky.cookie.name';
  assert.match(issues(parse(`${MIN}ingress: {annotations: {${key}: "a; Domain=evil"}}\n`)), /not valid for this annotation/);
  assert.match(issues(parse(`${MIN}ingress: {annotations: {traefik.ingress.kubernetes.io/service.serversscheme: ftp}}\n`)), /not valid/);
  assert.ok(parse(`${MIN}ingress: {annotations: {${key}: sess_id, traefik.ingress.kubernetes.io/service.passhostheader: "true"}}\n`).success);
});

test('sidecars share the volumes, and the dependency wait container takes host/port as arguments', () => {
  const { deployment } = manifestsFor(`${MIN}volumes: [{name: shared, mountPath: /data}]\nsidecars: [{name: s, image: busybox}]\n`);
  const side = deployment.spec.template.spec.containers.find((c) => c.name === 's');
  assert.deepStrictEqual(side.volumeMounts, [{ name: 'shared', mountPath: '/data' }]);
  const wait = require('../src/lib/manifestGen').buildWaitInitContainer('postgres', { host: 'x; touch /pwned', port: 5432 });
  assert.ok(!wait.command[2].includes('pwned') && !wait.command[2].includes('5432'), 'script text is constant');
  assert.deepStrictEqual(wait.command.slice(3), ['x; touch /pwned', '5432', 'postgres']);
});

test('addon templates only see their own variables', () => {
  const { substitute } = require('../src/lib/addonLoader');
  assert.strictEqual(substitute('{{release}}', { release: 'r' }), 'r');
  assert.throws(() => substitute('{{constructor}}', { release: 'r' }), /unknown template variable/);
  assert.throws(() => substitute('{{toString}}', {}), /unknown template variable/);
});

test('host guard refuses hosts already served by another namespace (kubectl is faked)', { skip: !POSIX }, () => {
  const bin = fs.mkdtempSync(path.join(tmp, 'hbin-'));
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh
[ -n "$FAKE_ING_ERROR" ] && echo "$FAKE_ING_ERROR" >&2 && exit 1
printf '%s' "$FAKE_ING"
exit 0
`, { mode: 0o755 });
  const { assertHostsFree } = require('../src/lib/hostGuard');
  const cfg = { name: 'orders', namespace: 'orders', hosts: ['orders', 'api'] };
  const ing = (ns, host) => ({ metadata: { namespace: ns, name: 'i' }, spec: { rules: [{ host: `${host}.local.test` }] } });
  const run = (env) => { Object.assign(process.env, env); try { assertHostsFree(cfg); } finally { for (const k of Object.keys(env)) delete process.env[k]; } };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    run({ FAKE_ING: JSON.stringify({ items: [] }) });
    run({ FAKE_ING: JSON.stringify({ items: [ing('orders', 'orders'), ing('billing', 'billing')] }) });   // own ingress + unrelated: fine
    assert.throws(() => run({ FAKE_ING: JSON.stringify({ items: [ing('billing', 'api')] }) }), /may already be served by billing\/i/);
    assert.throws(() => run({ FAKE_ING: 'garbage' }), /Couldn't read the list/);
    assert.throws(() => run({ FAKE_ING_ERROR: 'connection refused' }), /Couldn't check/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('pod annotations use an allowlist, labels a denylist', () => {
  for (const ok of ['note', 'team', 'prometheus.io/scrape', 'reloader.stakater.com/auto', 'fluentbit.io/exclude', 'checksum/config']) {
    assert.ok(parse(`${MIN}annotations: {${ok}: x}\n`).success, ok);
  }
  for (const bad of ['a.b', 'dapr.io/sidecar-image', 'prometheus.io.evil.com/x', 'evil.com/prometheus.io/x', 'Prometheus.io/scrape', 'cluster-autoscaler.kubernetes.io/safe-to-evict', 'io.kubernetes.cri-o.Devices', 'run.oci.handler', 'unknown.vendor.io/hook']) {
    assert.match(issues(parse(`${MIN}annotations: {${bad}: x}\n`)), /not allowed|annotations/, bad);
  }
  assert.ok(parse(`${MIN}labels: {team: core, tier: web}\n`).success);
});

test('resource quantities are exact, bounded, typed per resource and requests cannot exceed limits', () => {
  const ok = (r) => parse(`${MIN}resources: ${r}\n`);
  assert.ok(ok('{requests: {cpu: 500m, memory: 256Mi}, limits: {cpu: 1, memory: 1Gi}}').success);
  assert.ok(ok('{limits: {cpu: 0.5, memory: 1G}}').success);
  for (const bad of ['{limits: {cpu: 1Gi}}', '{limits: {memory: 1m}}', '{limits: {cpu: 0}}', '{limits: {cpu: 1025}}', '{limits: {memory: 2Ti}}', '{limits: {memory: 1.5}}', '{limits: {cpu: 1.5m}}', '{limits: {cpu: "1e3"}}']) {
    assert.ok(!ok(bad).success, bad);
  }
  assert.match(issues(ok('{requests: {memory: 1Gi}, limits: {memory: 512Mi}}')), /memory request 1Gi exceeds limit 512Mi/);
  assert.match(issues(ok('{requests: {cpu: 2}, limits: {cpu: 1500m}}')), /cpu request 2 exceeds limit 1500m/);
  assert.ok(ok('{requests: {memory: 1Gi}, limits: {memory: 1024Mi}}').success);   // equal across units
  assert.match(issues(parse(`${MIN}dependencies: [{type: postgres, resources: {requests: {cpu: 2}, limits: {cpu: 1}}}]\n`)), /cpu request/);
});

// ---- regression tests for red-team round 3 ----

test('complex keys and floods of aliases are refused before parsing', () => {
  const started = Date.now();
  const flood = Array.from({ length: 6000 }, (_, i) => `? [*s, ${i}]\n: 1`).join('\n');
  assert.throws(() => parse(`${MIN}$schema: &s "${'z'.repeat(20000)}"\n${flood}\n`), /complex mapping keys/);
  assert.throws(() => parse(`${MIN}x: [${Array.from({ length: 300 }, () => '*a').join(', ')}]\n`), /too many YAML aliases/);
  assert.ok(Date.now() - started < 4000, 'refused fast');
  const merged = parse(`${MIN}env:\n  <<: &base {Q: 1}\n  R: 2\nsidecars: [{name: s, image: x, env: *base}]\n`).data;   // normal anchors and merge keys still work
  assert.deepStrictEqual([merged.env.Q, merged.env.R, merged.sidecars[0].env.Q], ['1', '2', '1']);
  const r = parse(`${MIN}${'k'.repeat(5000)}: 1\n`);
  assert.ok(!issues(r).includes('k'.repeat(100)) && issues(r).length < 1200, 'a huge unknown key is cut in the message');
});

test('paths are resolved physically: link/.., missing paths under links, dangling links', { skip: !POSIX }, () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'phys-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const app = path.join(repo, 'a');
  fs.mkdirSync(app);
  const outside = fs.mkdtempSync(path.join(tmp, 'phys-out-'));
  fs.symlinkSync(repo, path.join(app, 'lnk_root'));
  fs.symlinkSync(outside, path.join(app, 'lnk_out'));
  fs.symlinkSync(path.join(tmp, 'nowhere-at-all'), path.join(app, 'dangling'));
  const ctx = (context) => ({ build: { context, dockerfile: 'Dockerfile' }, sync: [] });
  assert.doesNotThrow(() => assertPathsInsideProject(ctx('lnk_root'), app));
  assert.throws(() => assertPathsInsideProject(ctx('lnk_root/..'), app), /outside the project/);      // physical parent of the repo
  assert.throws(() => assertPathsInsideProject(ctx('lnk_root/../..'), app), /outside the project/);
  assert.throws(() => assertPathsInsideProject(ctx('lnk_out/newdir'), app), /outside the project/);   // missing path under a link out
  assert.throws(() => assertPathsInsideProject({ build: { context: '.', dockerfile: 'lnk_out/x.Dockerfile' }, sync: [] }, app), /build.dockerfile/);
  assert.throws(() => assertPathsInsideProject(ctx('dangling'), app), /points nowhere/);
  assert.doesNotThrow(() => assertPathsInsideProject(ctx('new/dir/not/yet'), app));                   // plain missing path inside the repo
});

test('a repository in the home directory is not a project root', { skip: !POSIX }, () => {
  const { projectRoot } = require('../src/lib/pathGuard');
  const fakeHome = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(fakeHome, '.git'));
  const app = path.join(fakeHome, 'work', 'app');
  fs.mkdirSync(app, { recursive: true });
  const old = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.strictEqual(projectRoot(app), fs.realpathSync(app));
  } finally {
    process.env.HOME = old;
  }
});

test('control characters, invalid UTF-8 and odd quantities give clean errors', () => {
  const bad = (cfg) => issues(appConfigSchema.safeParse({ name: 'a', port: 80, build: {}, ...cfg }));
  assert.match(bad({ build: { context: '..\u0000' } }), /control characters/);
  assert.match(bad({ sidecars: [{ name: 's', image: 'a\u0000b' }] }), /image/);
  assert.match(bad({ env: { A: 'x\u0000y' } }), /NUL/);
  assert.match(bad({ annotations: { note: 'x\u0000y' } }), /NUL/);
  const app = fs.mkdtempSync(path.join(tmp, 'utf8-'));
  fs.writeFileSync(path.join(app, '.env'), Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]));
  assert.throws(() => readEnvFile(app, '.env'), /not valid UTF-8/);
  assert.match(issues(parse(`${MIN}resources: {limits: {memory: 1.5}}\n`)), /"1.5"/);
  assert.match(issues(parse('name: a\nport: 8080.0\nbuild: {}\n')), /expected a number; write it plainly/);
});

test('standard app labels are allowed; more mesh and identity hooks are refused; UDP and TCP ports can share a number', () => {
  assert.ok(parse(`${MIN}labels: {app.kubernetes.io/name: shop, app.kubernetes.io/part-of: suite, helm.sh/chart: x}\n`).success);
  for (const key of ['istio.io/rev', 'istio.io/dataplane-mode', 'azure.workload.identity/use', 'cilium.io/policy', 'io.cilium.x']) {
    assert.match(issues(parse(`${MIN}labels: {${key}: x}\n`)), /not allowed/, key);
  }
  assert.ok(parse(`${MIN}ports: [{port: 4000}, {port: 4000, protocol: UDP}]\n`).success);
  assert.match(issues(parse(`${MIN}ports: [{port: 4000, protocol: UDP}]\ningress: {paths: [{path: /x, port: 4000}]}\n`)), /TCP entry/);
  assert.ok(parse(`${MIN}volumes: [{name: shm, mountPath: /dev/shm}]\n`).success);
  assert.match(issues(parse(`${MIN}volumes: [{name: v, mountPath: /dev/null}]\n`)), /mountPath/);
});

// ---- regression tests for the CLI red-team run (round 3B) ----

test('the Tiltfile only passes target when it is set (Tilt rejects None)', () => {
  for (const file of [path.join(__dirname, '..', 'templates', 'Tiltfile.tmpl'), ...['dotnet-api', 'node-app', 'python-app'].map((d) => path.join(__dirname, '..', '..', 'examples', d, 'Tiltfile'))]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/target=build\[.target.\]\s+or\s+None/.test(text), file);
    assert.ok(/extra\['target'\]/.test(text) && /\*\*extra/.test(text), file);
  }
  const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'Tiltfile.tmpl'), 'utf8');
  for (const d of ['dotnet-api', 'node-app', 'python-app']) {
    assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', '..', 'examples', d, 'Tiltfile'), 'utf8'), template, `${d} example matches the template`);
  }
});

test('command and args accept YAML scalars that look like booleans or numbers', () => {
  const r = parse(`${MIN}command: [true]\nargs: [sleep, 3600]\nprobes: {liveness: {command: [true]}}\n`);
  assert.ok(r.success, r.success ? '' : issues(r));
  assert.deepStrictEqual([r.data.command, r.data.args], [['true'], ['sleep', '3600']]);
});

test('environment names are checked even when none is selected', () => {
  assert.throws(() => applyEnvironment({ name: 'a', environments: { Bad_Name: {} } }, ''), /Environment name/);
  assert.throws(() => applyEnvironment({ name: 'a', environments: { ok: {}, UPPER: {} } }, 'ok'), /Environment name/);
  assert.deepStrictEqual(applyEnvironment({ name: 'a', environments: { ok: {} } }, ''), { name: 'a' });
});

test('host guard sees wildcard hosts and Traefik IngressRoutes (kubectl is faked)', { skip: !POSIX }, () => {
  const bin = fs.mkdtempSync(path.join(tmp, 'hg-'));
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh
case "$*" in
  *ingressroutes*) if [ -n "$FAKE_ROUTES_MISSING" ]; then echo "error: the server doesn't have a resource type \\"ingressroutes\\"" >&2; exit 1; fi; printf '%s' "$FAKE_ROUTES"; exit 0;;
  *) printf '%s' "$FAKE_ING"; exit 0;;
esac
`, { mode: 0o755 });
  const { assertHostsFree } = require('../src/lib/hostGuard');
  const cfg = { name: 'orders', namespace: 'orders', hosts: ['orders'] };
  const ing = (ns, host) => ({ metadata: { namespace: ns, name: 'i' }, spec: { rules: [{ host }] } });
  const route = (ns, match) => ({ metadata: { namespace: ns, name: 'r' }, spec: { routes: [{ match }] } });
  const run = (env) => { Object.assign(process.env, env); try { assertHostsFree(cfg); } finally { for (const k of Object.keys(env)) delete process.env[k]; } };
  const none = JSON.stringify({ items: [] });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    run({ FAKE_ING: none, FAKE_ROUTES: none });
    run({ FAKE_ING: none, FAKE_ROUTES_MISSING: '1' });                                                        // CRD not installed: fine
    assert.throws(() => run({ FAKE_ING: JSON.stringify({ items: [ing('x', '*.local.test')] }), FAKE_ROUTES: none }), /already be served by x\/ingress i/);
    assert.throws(() => run({ FAKE_ING: none, FAKE_ROUTES: JSON.stringify({ items: [route('x', 'Host(`a.local.test`) || Host(`b.com`, `orders.local.test`)')] }) }), /already be served by x\/ingressroute r/);
    run({ FAKE_ING: JSON.stringify({ items: [ing('x', '*.other.test'), ing('orders', 'orders.local.test')] }), FAKE_ROUTES: JSON.stringify({ items: [route('x', 'Host(`unrelated.test`)')] }) });
  } finally {
    process.env.PATH = oldPath;
  }
});

test('secret updates retry on conflict and refuse oversized values (kubectl is faked)', { skip: !POSIX }, () => {
  const bin = fs.mkdtempSync(path.join(tmp, 'sc-'));
  const state = path.join(bin, 'replaces');
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh
case "$*" in
  *"get namespace"*) printf '%s' '{"metadata":{"labels":{"localctl.dev/managed":"true"},"annotations":{"localctl.dev/app":"orders"}}}'; exit 0;;
  *"get secret"*) printf '%s' '{"metadata":{"resourceVersion":"7","labels":{"keep":"me","localctl.dev/managed":"true"},"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{old plaintext}","note":"x"}},"data":{"OLD":"b2xk"}}'; exit 0;;
  *"replace -f -"*) cat > "${state}.last"; echo x >> "${state}"; if [ "$(wc -l < "${state}")" -lt 3 ]; then echo 'Error from server (Conflict): Operation cannot be fulfilled on secrets "orders-secrets": the object has been modified' >&2; exit 1; fi; exit 0;;
esac
exit 0
`, { mode: 0o755 });
  const { setSecret } = require('../src/lib/appSecrets');
  const cfg = { name: 'orders', namespace: 'shop' };
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    setSecret(cfg, 'NEW', 'v');
    assert.strictEqual(fs.readFileSync(state, 'utf8').trim().split('\n').length, 3, 'retried twice after conflicts, then wrote');
    const written = JSON.parse(fs.readFileSync(`${state}.last`, 'utf8'));
    assert.strictEqual(written.metadata.resourceVersion, '7');
    assert.deepStrictEqual(written.metadata.labels, { keep: 'me', 'localctl.dev/managed': 'true' });          // existing metadata is carried over
    assert.deepStrictEqual(written.metadata.annotations, { note: 'x' });                                      // the old plaintext copy is dropped
    assert.deepStrictEqual(Object.keys(written.data).sort(), ['NEW', 'OLD']);
    assert.throws(() => setSecret(cfg, 'BIG', 'x'.repeat(600 * 1024)), /at most 512 KB/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- regression tests for red-team round 4 ----

// A fake kubectl driven by rules: the first rule whose `when` text appears in the arguments answers.
// Every call is logged (one line per call: the arguments, then the stdin if any) to `calls`.
function fakeKubectl(rules) {
  const dir = fs.mkdtempSync(path.join(tmp, 'fk-'));
  const calls = path.join(dir, 'calls.log');
  let script = `#!/bin/sh\nIN=""; if [ ! -t 0 ]; then IN="$(cat)"; fi\nprintf '%s\\n' "$*" >> "${calls}"; [ -n "$IN" ] && printf 'STDIN %s\\n' "$IN" >> "${calls}"\ncase "$*" in\n`;
  rules.forEach((r, i) => {
    fs.writeFileSync(path.join(dir, `out${i}`), r.out || '');
    fs.writeFileSync(path.join(dir, `err${i}`), r.err || '');
    script += `  *"${r.when}"*) cat "${dir}/out${i}"; cat "${dir}/err${i}" >&2; exit ${r.code || 0};;\n`;
  });
  script += '  *) exit 0;;\nesac\n';
  fs.writeFileSync(path.join(dir, 'kubectl'), script, { mode: 0o755 });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  const withFake = (fn) => {
    const old = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${old}`;
    try { return fn(); } finally { process.env.PATH = old; }
  };
  return { withFake, log };
}
const NS_OURS = JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' }, annotations: { 'localctl.dev/app': 'orders' } } });
const SECRET = (extra = {}) => JSON.stringify({ metadata: { resourceVersion: '5', labels: { 'localctl.dev/managed': 'true' } }, data: { A: 'YQ==' }, ...extra });

test('YAML pre-checks cannot be dodged with other spellings of complex keys or alias names', () => {
  const { loadYaml } = require('../src/lib/yamlLoad');
  for (const [label, text] of [
    ['? at end of line', 'a: 1\n?\n  [x]\n: 1\n'], ['CRLF', 'a: 1\r\n?\r\n  x\r\n: 1\r\n'], ['list marker', '- ? k\n  : v\n'],
    ['flow map', '{? k: v}'], ['flow seq', '[? k : v]'], ['tab after ?', 'a: 1\n?\tk\n: v\n'],
  ]) assert.throws(() => loadYaml(text), /complex mapping keys/, label);
  const flood = (name) => `a: &${name} x\nl:\n${Array.from({ length: 201 }, () => `  - *${name}`).join('\n')}\n`;
  for (const name of ['é', '.', '+x', 'ab-c', '_']) assert.throws(() => loadYaml(flood(name)), /too many YAML aliases/, name);
  const started = Date.now();
  assert.throws(() => parse(`${MIN}x: &é "${'z'.repeat(100000)}"\n${Array.from({ length: 1000 }, () => '?\n  [*é, 0]\n: 1').join('\n')}\n`), /complex mapping keys/);
  assert.ok(Date.now() - started < 3000, 'refused before the expensive parse');
  assert.deepStrictEqual(loadYaml('a: &x {q: 1}\nb: *x\nc:\n  <<: *x\nd: "what? yes"\ne: a ? b\n').c, { q: 1 });
});

test('"not found" is only believed when it is the exact NotFound for the exact object', { skip: !POSIX }, () => {
  const cfg = { name: 'orders', namespace: 'shop' };
  const misleading = ['Error from server (Forbidden): role "x" not found', 'Error from server (NotFound): secrets "y" not found', 'dial tcp: lookup server: no such host; server not found', 'error: context "k3d-x" not found', 'error: config file not found', 'Error from server (NotFound): namespaces "shop-other" not found'];
  for (const err of misleading) {
    const fk = fakeKubectl([{ when: 'get namespace', code: 1, err }]);
    assert.throws(() => fk.withFake(() => assertNamespaceOwnership(cfg)), /Couldn't check whether namespace "shop" is yours/, err);
  }
  const free = fakeKubectl([{ when: 'get namespace', code: 1, err: 'Error from server (NotFound): namespaces "shop" not found' }]);
  assert.doesNotThrow(() => free.withFake(() => assertNamespaceOwnership(cfg)));
  const dying = fakeKubectl([{ when: 'get namespace', out: JSON.stringify({ metadata: { deletionTimestamp: '2026-01-01T00:00:00Z', labels: { 'localctl.dev/managed': 'true' }, annotations: { 'localctl.dev/app': 'orders' } } }) }]);
  assert.throws(() => dying.withFake(() => assertNamespaceOwnership({ name: 'orders', namespace: 'shop' })), /being deleted/);
  const huge = fakeKubectl([{ when: 'get namespace', code: 1, err: `Error from server: ${'x'.repeat(100000)}` }]);
  try { huge.withFake(() => assertNamespaceOwnership(cfg)); assert.fail('should throw'); } catch (e) { assert.ok(e.message.length < 600, 'message is capped'); }
});

test('creating a namespace: Forbidden is reported, losing the race is detected (kubectl is faked)', { skip: !POSIX }, () => {
  const absent = { when: 'get namespace', code: 1, err: 'Error from server (NotFound): namespaces "shop" not found' };
  const denied = fakeKubectl([absent, { when: 'create -f -', code: 1, err: 'Error from server (Forbidden): namespaces is forbidden' }]);
  assert.throws(() => denied.withFake(() => ensureManagedNamespace('shop', 'orders')), /Couldn't create namespace "shop": Error from server \(Forbidden\)/);
  const lost = fakeKubectl([{ when: 'create -f -', code: 1, err: 'Error from server (AlreadyExists): namespaces "shop" already exists' }, absent]);
  // get says NotFound (first), create says AlreadyExists, then the ownership re-check finds a namespace of another app
  const lostOther = fakeKubectl([{ when: 'create -f -', code: 1, err: 'Error from server (AlreadyExists): ...' }, { when: 'get namespace shop -o json', out: JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' }, annotations: { 'localctl.dev/app': 'billing' } } }) }, { when: 'get namespace', code: 1, err: 'Error from server (NotFound): namespaces "shop" not found' }]);
  assert.throws(() => lostOther.withFake(() => ensureManagedNamespace('shop', 'orders')), /belongs to the app "billing"/);
  assert.ok(lost.log() === '' && /create -f -/.test(lostOther.log()));
});

test('secrets: only localctl-made Secrets are edited, odd answers are errors, deletes check for changes (kubectl is faked)', { skip: !POSIX }, () => {
  const cfg = { name: 'orders', namespace: 'shop' };
  const ns = { when: 'get namespace', out: NS_OURS };
  const plain = fakeKubectl([ns, { when: 'get secret', out: JSON.stringify({ metadata: { resourceVersion: '5' }, data: { A: 'YQ==' } }) }]);
  assert.throws(() => plain.withFake(() => setSecret(cfg, 'NEW', 'v')), /wasn't created by localctl/);
  for (const [label, out] of [['null', 'null'], ['array', '[]'], ['data string', JSON.stringify({ metadata: { resourceVersion: '1' }, data: 'abc' })], ['data array', JSON.stringify({ metadata: { resourceVersion: '1' }, data: ['a'] })], ['no resourceVersion', JSON.stringify({ metadata: { labels: { 'localctl.dev/managed': 'true' } }, data: {} })], ['not json', 'oops']]) {
    const fk = fakeKubectl([ns, { when: 'get secret', out }]);
    assert.throws(() => fk.withFake(() => setSecret(cfg, 'NEW', 'v')), /unexpected form|Couldn't read/, label);
  }
  // Forbidden whose text mentions Conflict is NOT retried and its real message is shown
  const forbidden = fakeKubectl([ns, { when: 'get secret', out: SECRET() }, { when: 'replace -f -', code: 1, err: 'Error from server (Forbidden): secrets "Conflict-team" is forbidden' }]);
  const t0 = Date.now();
  assert.throws(() => forbidden.withFake(() => setSecret(cfg, 'NEW', 'v')), /Couldn't write the secrets of "orders": Error from server \(Forbidden\)/);
  assert.ok(Date.now() - t0 < 2000, 'not retried');
  // replace says the Secret vanished: read again and create it
  let gets = 0;
  const vanished = fakeKubectl([ns, { when: 'get secret', out: SECRET() }, { when: 'replace -f -', code: 1, err: 'Error from server (NotFound): secrets "orders-secrets" not found' }]);
  assert.throws(() => vanished.withFake(() => setSecret(cfg, 'NEW', 'v')), /kept changing/);                 // keeps vanishing in this fake: gives up cleanly
  gets += (vanished.log().match(/replace -f -/g) || []).length;
  assert.strictEqual(gets, 8);
  // removing the last key: emptied under the resourceVersion check first, then deleted
  const last = fakeKubectl([ns, { when: 'get secret', out: SECRET() }]);
  assert.strictEqual(last.withFake(() => unsetSecret(cfg, 'A')), true);
  const log = last.log();
  assert.ok(log.indexOf('replace -f -') !== -1 && log.indexOf('replace -f -') < log.indexOf('delete secret'), 'replace before delete');
  assert.ok(/"data":\{\}/.test(log) && /"resourceVersion":"5"/.test(log));
});

test('host guard compares case-insensitively, reads every quote style and Host spelling, and is not quadratic', { skip: !POSIX }, () => {
  const { assertHostsFree, parseRule } = require('../src/lib/hostGuard');
  const cfg = { name: 'orders', namespace: 'orders', hosts: ['orders'] };
  const routes = (match, ns = 'x') => JSON.stringify({ items: [{ metadata: { namespace: ns, name: 'r' }, spec: { routes: [{ match }] } }] });
  const check = (match, ns) => fakeKubectl([{ when: 'ingressroutes', out: routes(match, ns) }, { when: 'get ingress', out: JSON.stringify({ items: [] }) }]).withFake(() => assertHostsFree(cfg));
  for (const match of ['Host(`Orders.Local.Test`)', 'Host(`orders.local.test.`)', 'HOST ( "orders.local.test" )', "host('orders.local.test')", 'Host(`a)b`, `orders.local.test`)', 'HostRegexp(`{sub:.+}.local.test`)', 'HostRegexp(`.*`)', 'Host(`*.local.test`)']) {
    assert.throws(() => check(match), /may already be served by x\/ingressroute r/, match);
  }
  assert.doesNotThrow(() => check('Host(`unrelated.example.com`) && PathPrefix(`/api`)'));
  assert.doesNotThrow(() => check('HostRegexp(`^[a-z]+\\.example\\.com$`)'));
  assert.doesNotThrow(() => check('Host(`orders.local.test`)', 'orders'));                                   // same namespace is ours
  assert.doesNotThrow(() => check('MyHost(`orders.local.test`)'));                                           // not a Host matcher
  const t0 = Date.now();
  parseRule('Host('.repeat(60000));
  assert.ok(Date.now() - t0 < 500, 'linear');
});

test('environment variable names may contain . and -; a disabled debug port does not reserve anything', () => {
  assert.ok(parse(`${MIN}env: {spring.profiles.active: dev, MY-VAR: x}\n`).success);
  assert.match(issues(parse(`${MIN}env: {"1BAD": x}\n`)), /environment variable name/);
  assert.ok(parse(`${MIN}debug: {enabled: false, port: 80}\n`).success);
  assert.match(issues(parse(`${MIN}debug: {enabled: true, port: 80}\n`)), /must differ/);
});

test('on POSIX a backslash is a file-name character, so a symlink named l\\x is still followed', { skip: !POSIX }, () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'bs-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const outside = fs.mkdtempSync(path.join(tmp, 'bs-out-'));
  fs.symlinkSync(outside, path.join(repo, 'l\\x'));
  assert.throws(() => assertPathsInsideProject({ build: { context: 'l\\x', dockerfile: 'Dockerfile' }, sync: [] }, repo), /outside the project/);
  assert.throws(() => assertPathsInsideProject({ build: { context: 'l\\x/sub', dockerfile: 'Dockerfile' }, sync: [] }, repo), /outside the project/);
});

test('the .local folder cannot be a symlink', { skip: !POSIX }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ls-'));
  const real = path.join(dir, 'real-config');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'config.yaml'), MIN);
  fs.symlinkSync(real, path.join(dir, '.local'));
  assert.throws(() => readRawConfig(path.join(dir, '.local', 'config.yaml')), /\.local folder is a symbolic link/);
});
