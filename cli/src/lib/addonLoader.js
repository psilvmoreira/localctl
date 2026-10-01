const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { run, capture } = require('./exec');

// Generic Helm-based addon loader. An addon is a folder containing an addon.yaml (what chart to
// pull and how to configure it) and, optionally, a config/ folder (literal files - dashboards,
// datasources, init scripts - that don't belong in Helm values but need to reach the chart as a
// ConfigMap). See docs/adding-tools.md for the full addon.yaml reference and a worked example.

function repoNameFor(url) {
  return `localctl-${crypto.createHash('md5').update(url).digest('hex').slice(0, 8)}`;
}

function ensureRepo(url) {
  const name = repoNameFor(url);
  // --force-update: idempotent even if re-pointed at a different URL under the same generated name.
  run('helm', ['repo', 'add', name, url, '--force-update'], { stdio: 'ignore' });
  run('helm', ['repo', 'update', name], { stdio: 'ignore', allowFail: true });
  return name;
}

function substitute(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    if (!(key in vars)) throw new Error(`Addon references unknown template variable "{{${key}}}"`);
    return vars[key];
  });
}

function ensureNamespace(ns) {
  if (capture('kubectl', ['get', 'namespace', ns]).status !== 0) {
    run('kubectl', ['create', 'namespace', ns], { stdio: 'ignore', allowFail: true });
  }
}

// Generates each secret's value once and stores it as a real k8s Secret; a re-run that finds the
// Secret already there leaves it alone, so app data doesn't lose its password out from under it
// on every `localctl up`.
function ensureSecret(name, namespace, keys) {
  ensureNamespace(namespace);
  if (capture('kubectl', ['get', 'secret', name, '-n', namespace]).status === 0) return;
  const args = ['create', 'secret', 'generic', name, '-n', namespace];
  for (const key of keys) {
    args.push(`--from-literal=${key}=${crypto.randomBytes(16).toString('hex')}`);
  }
  run('kubectl', args, { stdio: 'ignore' });
}

// Turns a folder of literal files (dashboards, datasource definitions, init scripts - whatever
// the chart expects to mount, not a Helm value) into a real ConfigMap.
function ensureConfigMap(name, namespace, configDir) {
  ensureNamespace(namespace);
  const files = fs.readdirSync(configDir).filter((f) => fs.statSync(path.join(configDir, f)).isFile());
  const args = ['create', 'configmap', name, '-n', namespace, '--dry-run=client', '-o', 'yaml'];
  files.forEach((f) => args.push(`--from-file=${path.join(configDir, f)}`));
  const rendered = capture('kubectl', args);
  if (rendered.status !== 0) throw new Error(`Failed to render ConfigMap for ${configDir}: ${rendered.stderr}`);
  run('kubectl', ['apply', '-f', '-'], { stdio: ['pipe', 'ignore', 'inherit'], input: rendered.stdout });
}

function helmTemplate(release, chart, valuesObj, namespace) {
  const repoName = ensureRepo(chart.repo);
  const tmpValues = path.join(os.tmpdir(), `localctl-addon-values-${process.pid}-${Date.now()}.yaml`);
  fs.writeFileSync(tmpValues, yaml.dump(valuesObj));
  try {
    // --no-hooks: excludes `helm test` pods and similar hook resources from the rendered output -
    // we apply this YAML with plain `kubectl apply`, not `helm install`, so nothing would ever
    // run `helm test` to use them; left in, they'd just sit in the namespace as inert clutter.
    const args = ['template', release, `${repoName}/${chart.name}`, '-f', tmpValues, '-n', namespace, '--no-hooks'];
    if (chart.version) args.push('--version', chart.version);
    const res = capture('helm', args);
    if (res.status !== 0) {
      throw new Error(`helm template failed for chart "${chart.name}":\n${res.stderr}`);
    }
    return res.stdout;
  } finally {
    fs.rmSync(tmpValues, { force: true });
  }
}

// Every chart names its Service differently (Bitnami's own "dedupe release name vs chart name"
// logic alone means postgresql uses `<release>-postgresql` but redis uses `<release>-master`, no
// chart name at all, when the release name already contains "redis") - predicting it from a
// naming convention is fragile per-chart guesswork. Reading it back out of the chart's own
// rendered output is not: whatever the chart actually created is, by definition, correct.
function findPrimaryService(manifestYaml) {
  const docs = yaml.loadAll(manifestYaml).filter(Boolean);
  const services = docs.filter((d) => d.kind === 'Service');
  return services.find((s) => !/-headless$|-hl$/.test(s.metadata.name)) || services[0] || null;
}

function findServiceHost(manifestYaml) {
  const svc = findPrimaryService(manifestYaml);
  return svc ? svc.metadata.name : null;
}

// Same "read it back, don't guess" reasoning as findServiceHost - a wait-for-dependency init
// container (manifestGen.js) needs a real port, and addon.yaml's own `env` block is free to name
// its port var anything (POSTGRES_PORT, REDIS_PORT, ...), so it's not something to parse generically.
function findServicePort(manifestYaml) {
  const svc = findPrimaryService(manifestYaml);
  const port = svc && svc.spec.ports && svc.spec.ports[0];
  return port ? port.port : null;
}

// A small tracking ConfigMap bundled into the addon's own manifest output, so its lifecycle is
// tied to the addon's (created and deleted together, no separate cleanup code needed). This is
// what `localctl addons status` reads to list every addon instance in the cluster - it doesn't
// try to guess which workload kind(s) a given chart happens to use (Deployment, StatefulSet,
// DaemonSet all show up in real charts; guessing which is exactly the fragility that bit
// `localctl status`'s own dependency listing once already).
function buildAddonRecord({ release, namespace, addonName, chart, owner }) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: `${release}-localctl-addon`,
      namespace,
      labels: { 'localctl.dev/addon': 'true' },
    },
    data: {
      addon: addonName,
      chart: chart.name,
      version: String(chart.version || ''),
      owner: owner || '',
    },
  };
}

// Loads one addon (given its folder) and returns the rendered manifest YAML, plus any env vars
// it wants injected into the caller's own container (per-app addons only - see manifestGen.js).
function loadAddon(addonDir, { release, namespace, addonName, owner, extraVars = {}, chartVersionOverride }) {
  const specPath = path.join(addonDir, 'addon.yaml');
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));

  const chart = { ...spec.chart, version: chartVersionOverride || spec.chart.version };
  const vars = { release, namespace, ...extraVars };

  if (spec.secrets) {
    const secretName = `${release}-secret`;
    ensureSecret(secretName, namespace, Object.keys(spec.secrets));
    vars.secretName = secretName;
  }

  const configDir = path.join(addonDir, 'config');
  if (spec.config && fs.existsSync(configDir)) {
    const configMapName = `${release}-config`;
    ensureConfigMap(configMapName, namespace, configDir);
    vars.configMapName = configMapName;
  }

  const valuesYaml = substitute(spec.values, vars);
  const valuesObj = yaml.load(valuesYaml) || {};
  const manifestYaml = helmTemplate(release, chart, valuesObj, namespace);
  vars.serviceHost = findServiceHost(manifestYaml);
  const servicePort = findServicePort(manifestYaml);

  const env = {};
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      env[k] = substitute(v, vars);
    }
  }

  // Unlike `env` (plain values), these become a real k8s secretKeyRef in the app's Deployment -
  // the actual password never passes through a plaintext env value, config file, or `helm` value.
  const envFromSecret = {};
  if (spec.envFromSecret) {
    for (const [k, ref] of Object.entries(spec.envFromSecret)) {
      envFromSecret[k] = { secret: substitute(ref.secret, vars), key: substitute(ref.key, vars) };
    }
  }

  const record = buildAddonRecord({ release, namespace, addonName: addonName || path.basename(addonDir), chart, owner });
  // trimEnd() + explicit '\n' before the separator: `helm template` output doesn't always end
  // with a trailing newline, and joining on a bare '---\n' in that case glues the separator
  // directly onto the last line's content with no line break, corrupting the YAML.
  const fullManifestYaml = [manifestYaml.trimEnd(), yaml.dump(record).trimEnd()].join('\n---\n');

  // The addon's real, rendered host+port - not env's POSTGRES_HOST/POSTGRES_PORT (those are only
  // as reliable as each addon.yaml's own naming), so a wait-for-dependency init container
  // (manifestGen.js) can work for any addon generically, built-in or your own.
  const connect = vars.serviceHost && servicePort ? { host: vars.serviceHost, port: servicePort } : null;

  return { manifestYaml: fullManifestYaml, env, envFromSecret, connect };
}

module.exports = { loadAddon, substitute };
