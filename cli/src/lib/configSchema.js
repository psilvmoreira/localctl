const path = require('path');
const { z } = require('zod');
const { knownAddonTypes } = require('./manifestGen');
const { isReservedNamespace } = require('./namespaces');
const { parseCpu, parseMem, checkResources } = require('./quantities');

// Dependency types are discovered from cli/src/lib/addons/<type>/addon.yaml (see
// docs/adding-tools.md) rather than hardcoded here - dropping in a new addon folder is enough to
// make it usable, no code change needed.
// YAML reads `version: 16.1` or `database: 2024` as numbers; for fields that are text by nature,
// accept numbers and booleans and turn them into strings. (yamlLoad.js already keeps lookalikes
// such as 1.10, 1e3 or 0x10 as text.)
const noControl = (v) => !/\u0000/.test(v);
const text = z.union([z.string(), z.number(), z.boolean()]).transform(String).refine(noControl, 'must not contain a NUL character');

// These three are substituted as raw text into an addon's Helm values (and `version` into a
// `helm --version` argument), so they are limited to what they legitimately look like. Anything
// with a quote, colon or newline could otherwise inject extra Helm values.
const restricted = (regex, hint) => text.pipe(z.string().regex(regex, hint));

// A Kubernetes DNS label: starts and ends with a letter or digit, so it can never be read as a
// command-line flag (`-x`) by kubectl or tilt.
const dnsLabel = z.string().max(63, 'must be at most 63 characters').regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'must be lowercase letters, digits and dashes, starting and ending with a letter or digit');

// Kubernetes quantities, parsed exactly (see quantities.js): cpu as 500m, 1 or 0.5; memory as
// 256Mi, 2Gi or 1G. YAML numbers (`cpu: 1`) are accepted. Zero and huge values are refused.
const quantityOf = (parse) => text.pipe(z.string().superRefine((v, ctx) => {
  try { parse(v); } catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message.includes(String(v)) ? e.message : `"${String(v).slice(0, 30)}": ${e.message}` }); }
}));
const resourceSpec = z
  .strictObject({
    cpu: quantityOf(parseCpu).optional(),
    memory: quantityOf(parseMem).optional(),
  })
  .optional();

const dependencySchema = z.strictObject({
  type: z.enum(knownAddonTypes()),
  version: restricted(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, 'must look like a chart version, e.g. 18.12.2').optional(),
  database: restricted(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'must be letters, digits and underscores, not starting with a digit').optional(),
  storage: restricted(/^(?!0+(\.0+)?(Mi|Gi|Ti)$)[0-9]{1,6}(\.[0-9]{1,3})?(Mi|Gi|Ti)$/, 'must be a size like 512Mi or 2Gi').optional(),
  // CPU/memory for the dependency's pod, e.g. { limits: { memory: 256Mi } }. Needs the addon to
  // declare `resourcesPath` in its addon.yaml.
  resources: z.strictObject({ requests: resourceSpec, limits: resourceSpec }).optional(),
});

// Build and sync paths are relative to the app folder (`..` is fine for monorepos). Absolute paths
// and `~` are refused so a config can't pull in files from elsewhere on the machine.
const relativePath = z.string().min(1).max(1000)
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'must not contain control characters')
  .refine((p) => !/^([\\/]|[A-Za-z]:|~)/.test(p), 'must be a relative path, not absolute or starting with ~');

// An image reference can't start with `-` (it would be read as a flag) or contain whitespace.
const imageRef = z.string().min(1).max(300).regex(/^[A-Za-z0-9][^\s\u0000-\u001f\u007f]*$/, 'must be an image reference such as repo/name:tag');

const envKey = z.string().max(253).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name (letters, digits, _)');
// Kubernetes accepts letters, digits, `_`, `-` and `.` in variable names (spring.profiles.active).
const envVarName = z.string().max(253).regex(/^[A-Za-z_][A-Za-z0-9._-]*$/, 'must be a valid environment variable name (letters, digits, _ . -)');
const envMap = z.record(envVarName, z.string().refine(noControl, 'must not contain a NUL character')).refine((o) => Object.keys(o).length <= 200, 'at most 200 variables');

const portNumber = z.number().int().min(1).max(65535);

// Kubernetes label/annotation keys and label values. `app` and the `localctl.dev/` prefix are
// reserved: the Deployment selector and localctl's own bookkeeping rely on them.
const k8sKey = z
  .string()
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?\/)?[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/, 'is not a valid label/annotation key')
  .refine((k) => k.split('/').pop().length <= 63, 'the part after "/" must be at most 63 characters');
const labelValue = text.pipe(z.string().max(63).regex(/^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)?$/, 'is not a valid label value'));
const isReservedKey = (key) => key === 'app' || key.startsWith('localctl.dev/');

// A URL path: starts with /, no empty segments (`//`), no `..`, no percent escapes, bounded size.
const urlPath = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~/-]*$/, 'must start with / and use only letters, digits and . _ ~ - /')
  .refine((p) => !p.includes('//') && !p.split('/').includes('..'), 'cannot contain "//" or ".."');

// Extra container ports beyond `port` (a second HTTP port, gRPC, a UDP listener). They are added
// to the container and the in-cluster Service; `forward: true` also forwards it to localhost.
const extraPortSchema = z.strictObject({
  port: portNumber,
  name: z.string().regex(/^[a-z]([a-z0-9]|-(?!-)){0,13}[a-z0-9]$|^[a-z]$/, 'must be 1-15 lowercase letters, digits or single dashes, starting with a letter').optional(),
  protocol: z.enum(['TCP', 'UDP']).default('TCP'),
  forward: z.boolean().default(false),
});

// Traefik annotations a config may set. `router.priority` (could outrank another app's route),
// `router.middlewares` (can point into other namespaces) and `router.tls.*` are left out.
const INGRESS_ANNOTATIONS = [
  'traefik.ingress.kubernetes.io/service.passhostheader',
  'traefik.ingress.kubernetes.io/service.sticky.cookie',
  'traefik.ingress.kubernetes.io/service.sticky.cookie.name',
  'traefik.ingress.kubernetes.io/service.sticky.cookie.secure',
  'traefik.ingress.kubernetes.io/service.serversscheme',
];

// What each allowed annotation may be set to; nothing here can carry a newline or `;`.
const INGRESS_ANNOTATION_VALUES = {
  'traefik.ingress.kubernetes.io/service.passhostheader': /^(true|false)$/,
  'traefik.ingress.kubernetes.io/service.sticky.cookie': /^(true|false)$/,
  'traefik.ingress.kubernetes.io/service.sticky.cookie.name': /^[A-Za-z0-9._-]{1,64}$/,
  'traefik.ingress.kubernetes.io/service.sticky.cookie.secure': /^(true|false)$/,
  'traefik.ingress.kubernetes.io/service.serversscheme': /^(http|https|h2c)$/,
};

// Pod annotations are read by container runtimes, CNIs and meshes, and every vendor invents its
// own keys, so a denylist keeps leaking. Annotations therefore use an allowlist: a plain key with
// no domain (`note`, `team`) or a key under a few well-known, harmless prefixes. Labels keep a
// denylist below because their keys are mostly free-form.
const POD_ANNOTATION_ALLOWED = /^(?:[A-Za-z0-9_-]+|(?:prometheus\.io|reloader\.stakater\.com|fluentbit\.io|ad\.datadoghq\.com|co\.elastic\.logs|logging\.banzaicloud\.io|backup\.velero\.io|checksum)\/[A-Za-z0-9][A-Za-z0-9._-]*)$/;

// Label keys that namespaces, runtimes or meshes act on.
const isDangerousLabelKey = (key) =>
  // app.kubernetes.io/* are the standard descriptive labels (name, part-of, version...).
  (!/^app\.kubernetes\.io\//.test(key) && /(^|[./])kubernetes\.io\//.test(key)) || /^io\.kubernetes\./.test(key) || /^k8s\./.test(key) ||
  /apparmor|seccomp/i.test(key) || /\.cncf\.io\//.test(key) ||
  // Runtime, mesh, CNI and cloud-identity hooks that act on pod annotations.
  /^(io\.katacontainers|io\.containerd|runtime\.containerd|run\.oci|io\.podman|org\.systemd|openshift\.io|iam\.amazonaws\.com|vault\.hashicorp\.com|cni\.projectcalico\.org|v1\.multus-cni\.io|sidecar\.istio\.io|traffic\.sidecar\.istio\.io|istio\.io|linkerd\.io|config\.linkerd\.io|azure\.workload\.identity|cilium\.io|io\.cilium)([./]|$)/.test(key);

// Ingress extras. `hosts` are more subdomains of local.test that route to the same app; `paths`
// replaces the default "/" route; only Traefik's own annotations are accepted.
const ingressSchema = z
  .strictObject({
    hosts: z.array(dnsLabel).default([]),
    paths: z
      .array(z.strictObject({
        path: urlPath,
        port: portNumber.optional(),
      }))
      .default([]),
    annotations: z
      .record(z.enum(INGRESS_ANNOTATIONS, { errorMap: () => ({ message: `not an allowed annotation; allowed: ${INGRESS_ANNOTATIONS.join(', ')}` }) }), text)
      .default({}),
  })
  .default({});

// Scratch space shared by the app, its sidecars and init containers. Always an emptyDir: it lives
// and dies with the pod. There is no hostPath on purpose, so a config can't mount node folders.
const MOUNT_DENYLIST = ['/proc', '/sys', '/dev', '/var/run/secrets', '/run/secrets'];
const MOUNT_EXACT_DENY = ['/run', '/var/run'];

const volumeSchema = z.strictObject({
  name: dnsLabel,
  mountPath: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9._/-]*$/, 'must be an absolute path (letters, digits, . _ - /)')
    .refine((p) => p === path.posix.normalize(p) && p !== '/' && !p.endsWith('/'), 'must be written in its plain form: no "//", "/./", ".." or trailing "/", and not "/"')
    .refine((p) => {
      const lower = p.toLowerCase();
      if (lower === '/dev/shm' || lower.startsWith('/dev/shm/')) return true; // shared memory for browsers, databases
      return !MOUNT_EXACT_DENY.includes(lower) && !MOUNT_DENYLIST.some((d) => lower === d || lower.startsWith(`${d}/`));
    }, `cannot be ${MOUNT_EXACT_DENY.join(' or ')} or inside ${MOUNT_DENYLIST.join(', ')}`),
  sizeLimit: restricted(/^(?!0+(\.0+)?(Mi|Gi|Ti)$)[0-9]{1,6}(\.[0-9]{1,3})?(Mi|Gi|Ti)$/, 'must be a size like 256Mi or 1Gi').optional(),
});

// Runs to completion before the app starts, in the app's own image unless `image` is given: the
// place for database migrations or seed scripts.
const initContainerSchema = z.strictObject({
  name: dnsLabel,
  image: imageRef.optional(),
  command: z.array(text).optional(),
  args: z.array(text).optional(),
  env: envMap.default({}),
});

// Only settings that tighten the container are accepted: no `privileged`, no added capabilities,
// and allowPrivilegeEscalation can only be turned off.
const securityContextSchema = z
  .strictObject({
    runAsUser: z.number().int().min(0).max(65535).optional(),
    runAsGroup: z.number().int().min(0).max(65535).optional(),
    runAsNonRoot: z.boolean().optional(),
    readOnlyRootFilesystem: z.boolean().optional(),
    allowPrivilegeEscalation: z.literal(false).optional(),
  })
  .refine((c) => !(c.runAsNonRoot === true && c.runAsUser === 0), { message: 'runAsNonRoot: true contradicts runAsUser: 0' });

const debugSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    port: portNumber.optional(),
    type: z.enum(['node', 'python', 'go', 'java', 'dotnet']).optional(),
  })
  .default({ enabled: false });

const syncEntrySchema = z.strictObject({
  localPath: relativePath,
  remotePath: z.string(),
});

// An extra container in the same pod as your app - the classic k8s sidecar pattern (a DB admin
// UI next to a database, a log/metrics shipper, a background job runner next to a web app). It
// shares the pod's network namespace with your app automatically - no Service needed for your app
// to reach it, just `localhost:<port>`. See docs/config-schema.md for a worked example.
const sidecarSchema = z.strictObject({
  name: dnsLabel,
  image: imageRef,
  port: portNumber.optional(),
  command: z.array(text).optional(),
  args: z.array(text).optional(),
  env: envMap.default({}),
});

const runStepSchema = z.strictObject({
  command: z.string().min(1),
  trigger: z.array(z.string()).optional(),
});

// A single probe - defaults to a plain TCP check on the app's own `port` if `path` isn't given
// (see buildProbe() in manifestGen.js). Applies to the main app container only.
const probeSchema = z
  .strictObject({
    path: urlPath.optional(),
    // Runs inside the container; healthy when it exits 0. Alternative to `path`.
    command: z.array(text.pipe(z.string().min(1))).min(1).optional(),
    initialDelaySeconds: z.number().int().min(0).max(3600).optional(),
    periodSeconds: z.number().int().min(1).max(3600).optional(),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
    failureThreshold: z.number().int().min(1).max(1000).optional(),
  })
  .refine((p) => !(p.path && p.command), { message: 'use either "path" (HTTP) or "command", not both' });

const probesSchema = z
  .strictObject({
    readiness: probeSchema.optional(),
    liveness: probeSchema.optional(),
    // Gives slow-starting apps time before liveness checks begin; absent unless set here.
    startup: probeSchema.optional(),
  })
  .default({});

// Every object is strict: a typo like `replica: 3` is an error with a "did you mean" hint, not a
// silently ignored key. `$schema` is allowed so JSON-style files that carry one still load.
const appConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    name: dnsLabel,
    subdomain: dnsLabel.optional(),
    namespace: dnsLabel.optional(),
    port: portNumber,
    // Replaces the image's CMD/ENTRYPOINT arguments for the main container (like docker run
    // args): `command` overrides ENTRYPOINT, `args` overrides CMD.
    command: z.array(text).optional(),
    args: z.array(text).optional(),
    build: z.strictObject({
      context: relativePath.default('.'),
      dockerfile: relativePath.default('Dockerfile'),
      // Multi-stage build target (docker build --target).
      target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a build stage name').optional(),
      // docker build --build-arg KEY=value
      args: z.record(envKey, text).default({}),
      // Paths Tilt leaves out of the build context and does not watch (like .dockerignore).
      ignore: z.array(z.string()).default([]),
    }),
    env: envMap.default({}),
    // A dotenv-style file (KEY=value per line) read relative to the app folder and merged into
    // `env`; keys written in `env` win. Meant for non-secret settings you don't want in the YAML.
    envFile: z.string().optional(),
    // Names only - values never live here. Set with `localctl app secrets set <KEY>`, which
    // stores the value once as a real k8s Secret and injects it via secretKeyRef, the same
    // never-plaintext principle addon-provided credentials already follow.
    secrets: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be UPPER_SNAKE_CASE'))
      .default([]),
    replicas: z.number().int().min(1).max(20).default(1),
    resources: z
      .strictObject({ requests: resourceSpec, limits: resourceSpec })
      .optional(),
    debug: debugSchema,
    probes: probesSchema,
    dependencies: z.array(dependencySchema).default([]),
    sidecars: z.array(sidecarSchema).default([]),
    sync: z.array(syncEntrySchema).default([]),
    // Commands run inside the container after files are synced; with `trigger`, only when one of
    // those paths changed (for example `npm install` when package.json changes).
    run: z.array(runStepSchema).default([]),
    tls: z.boolean().default(true),
    ports: z.array(extraPortSchema).default([]),
    ingress: ingressSchema,
    volumes: z.array(volumeSchema).default([]),
    initContainers: z.array(initContainerSchema).default([]),
    // Extra labels and (pod) annotations. `app` and `localctl.dev/*` are reserved.
    labels: z.record(k8sKey, labelValue).default({}),
    annotations: z.record(k8sKey, text).default({}),
    imagePullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).optional(),
    terminationGracePeriodSeconds: z.number().int().min(0).max(3600).optional(),
    securityContext: securityContextSchema.optional(),
    // Named overrides, merged over the rest of this file when selected with `localctl app up
    // --env <name>` (objects merge, lists replace). `name` and `namespace` can't be overridden.
    environments: z.record(dnsLabel, z.record(z.unknown())).optional(),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // Size limits: a config is a handful of settings; huge lists only make slow, giant manifests.
    const limits = [
      ['ports', cfg.ports, 20], ['ingress.hosts', cfg.ingress.hosts, 20], ['ingress.paths', cfg.ingress.paths, 50],
      ['volumes', cfg.volumes, 20], ['initContainers', cfg.initContainers, 10], ['sidecars', cfg.sidecars, 10],
      ['dependencies', cfg.dependencies, 10], ['sync', cfg.sync, 50], ['run', cfg.run, 50], ['secrets', cfg.secrets, 100],
      ['build.ignore', cfg.build.ignore, 100], ['command', cfg.command || [], 100], ['args', cfg.args || [], 100],
      ['labels', Object.keys(cfg.labels), 50], ['annotations', Object.keys(cfg.annotations), 50],
      ['build.args', Object.keys(cfg.build.args), 100],
    ];
    for (const [name, list, max] of limits) {
      if (list.length > max) issue(name.split('.'), `at most ${max} entries are allowed (found ${list.length})`);
    }
    for (const [where, res] of [['resources', cfg.resources], ...cfg.dependencies.map((d, i) => [`dependencies.${i}.resources`, d.resources])]) {
      if (!res) continue;
      try { checkResources(res); } catch (e) { issue(where.split('.'), e.message); }
    }
    const types = cfg.dependencies.map((d) => d.type);
    if (new Set(types).size !== types.length) issue(['dependencies'], 'each dependency type can appear once per app');
    // Helm release names are limited to 53 characters and are built as "<name>-<type>".
    cfg.dependencies.forEach((d, i) => {
      if (`${cfg.name}-${d.type}`.length > 53) issue(['dependencies', i, 'type'], `"${cfg.name}-${d.type}" is longer than 53 characters (a Helm limit); use a shorter app name`);
    });

    const servicePorts = [cfg.port, ...cfg.ports.filter((p) => p.protocol === 'TCP').map((p) => p.port)];
    // A port number can be used once per protocol (DNS on 53 uses both TCP and UDP).
    const taken = new Set([`${cfg.port}/TCP`]);
    if (cfg.debug.enabled && cfg.debug.port) {
      if (cfg.debug.port === cfg.port) issue(['debug', 'port'], '"debug.port" must differ from "port"');
      taken.add(`${cfg.debug.port}/TCP`);
    }
    const portNames = new Set(['http', ...(cfg.debug.enabled && cfg.debug.port ? ['debug'] : [])]);
    cfg.ports.forEach((p, i) => {
      const name = p.name || (p.protocol === 'UDP' ? `p${p.port}-udp` : `p${p.port}`);
      if (portNames.has(name)) issue(['ports', i, 'name'], `port name "${name}" is already used (the app uses "http", and "debug" when debugging)`);
      portNames.add(name);
    });
    cfg.ports.forEach((p, i) => {
      if (taken.has(`${p.port}/${p.protocol}`)) issue(['ports', i, 'port'], `port ${p.port}/${p.protocol} is already used by "port", "debug.port" or another entry`);
      taken.add(`${p.port}/${p.protocol}`);
    });
    cfg.sidecars.forEach((s, i) => {
      if (s.port && taken.has(`${s.port}/TCP`)) issue(['sidecars', i, 'port'], `port ${s.port} is already used by the app or another entry; containers in a pod share one network`);
      if (s.port) taken.add(`${s.port}/TCP`);
      if (s.name.startsWith('wait-for-')) issue(['sidecars', i, 'name'], '"wait-for-*" is reserved for the automatic dependency wait');
    });
    cfg.ingress.paths.forEach((p, i) => {
      if (p.port && !servicePorts.includes(p.port)) {
        issue(['ingress', 'paths', i, 'port'], `port ${p.port} is not "port" or a TCP entry of "ports"`);
      }
    });
    for (const [key, value] of Object.entries(cfg.ingress.annotations)) {
      const rule = INGRESS_ANNOTATION_VALUES[key];
      if (rule && !rule.test(String(value))) issue(['ingress', 'annotations', key], `value "${String(value).slice(0, 40)}" is not valid for this annotation`);
    }
    const subdomain = cfg.subdomain || cfg.name;
    if (new Set(cfg.ingress.hosts).size !== cfg.ingress.hosts.length || cfg.ingress.hosts.includes(subdomain)) {
      issue(['ingress', 'hosts'], `hosts must be unique and different from the main subdomain "${subdomain}"`);
    }

    for (const key of [...Object.keys(cfg.labels), ...Object.keys(cfg.annotations)]) {
      if (isReservedKey(key)) issue(['labels'], `"${key}" is reserved (the "app" label and localctl.dev/* are managed by localctl)`);
    }
    for (const key of Object.keys(cfg.annotations)) {
      if (!POD_ANNOTATION_ALLOWED.test(key)) issue(['annotations'], `"${key}" is not allowed: pod annotations may be a plain key (like "note") or sit under prometheus.io/, reloader.stakater.com/, fluentbit.io/, ad.datadoghq.com/, co.elastic.logs/, logging.banzaicloud.io/, backup.velero.io/ or checksum/`);
    }
    for (const key of Object.keys(cfg.labels)) {
      if (isDangerousLabelKey(key) || /^(istio-injection|pod-security\.kubernetes\.io\/)/.test(key)) {
        issue(['labels'], `"${key}" is not allowed: namespaces, meshes and the cluster act on this label`);
      }
    }
    const namespace = cfg.namespace || cfg.name;
    if (isReservedNamespace(namespace)) {
      issue([cfg.namespace ? 'namespace' : 'name'], `the namespace "${namespace}" is reserved for Kubernetes and localctl itself; choose another ${cfg.namespace ? '"namespace"' : '"name" or set "namespace"'}`);
    }

    // Container names are shared by the app, sidecars and init containers in one pod.
    const names = [cfg.name, ...cfg.sidecars.map((s) => s.name), ...cfg.initContainers.map((c) => c.name)];
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) issue(['initContainers'], `container name "${dup}" is used more than once (the app, sidecars and init containers share one namespace of names)`);
    cfg.initContainers.forEach((c, i) => {
      if (c.name.startsWith('wait-for-')) issue(['initContainers', i, 'name'], '"wait-for-*" is reserved for the automatic dependency wait');
    });
    const volumeNames = cfg.volumes.map((v) => v.name);
    if (new Set(volumeNames).size !== volumeNames.length) issue(['volumes'], 'volume names must be unique');
    if (new Set(cfg.volumes.map((v) => v.mountPath)).size !== cfg.volumes.length) issue(['volumes'], 'mountPath values must be unique');

    if (cfg.run.length > 0 && cfg.sync.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run'],
        message: '"run" commands execute after files are synced into the container, so they need at least one "sync" entry.',
      });
    }
    const overlap = cfg.secrets.filter((key) => key in cfg.env);
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secrets'],
        message: `${overlap.join(', ')} can't be in both "env" and "secrets" - pick one.`,
      });
    }
  });

// Keys accepted at `path` (a list of object keys and array indexes) in the config, for "did you
// mean" hints. Walks through the wrappers zod puts around a schema (default, optional, effects,
// arrays) down to the object that owns the keys.
function knownKeysAt(schema, path) {
  let node = schema;
  const unwrap = (n) => {
    for (;;) {
      const def = n._def;
      if (def.innerType) n = def.innerType;
      else if (def.schema) n = def.schema;
      else return n;
    }
  };
  for (const part of [...path, null]) {
    node = unwrap(node);
    if (node._def.typeName === 'ZodArray') {
      node = unwrap(node._def.type);
    }
    if (part === null) break;
    if (typeof part === 'number') continue;
    if (!node.shape || !node.shape[part]) return [];
    node = node.shape[part];
  }
  return node.shape ? Object.keys(node.shape).filter((k) => k !== '$schema') : [];
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

function closestKey(key, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  return best !== null && bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : null;
}

// One readable line per problem, with a "did you mean" hint for unknown fields.
function describeIssues(issues) {
  const lines = [];
  for (const issue of issues) {
    const where = issue.path.join('.') || '(root)';
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeysAt(appConfigSchema, issue.path);
      for (const rawKey of issue.keys) {
        // Keys can be huge (YAML allows anything as a key), so cap what is shown and compared.
        const key = rawKey.length > 60 ? `${rawKey.slice(0, 57)}...` : rawKey;
        const hint = rawKey.length > 64 ? null : closestKey(key, known);
        const options = known.length ? ` Valid fields here: ${known.join(', ')}.` : '';
        lines.push(`  - ${where}: unknown field "${key}"${hint ? ` - did you mean "${hint}"?` : '.'}${hint ? '' : options}`);
      }
    } else if (issue.code === 'invalid_type' && issue.expected === 'number' && issue.received === 'string') {
      lines.push(`  - ${where}: expected a number; write it plainly, like 8080 (no quotes, decimals or +)`);
    } else {
      lines.push(`  - ${where}: ${issue.message}`);
    }
  }
  return lines.join('\n');
}

module.exports = { appConfigSchema, describeIssues };
