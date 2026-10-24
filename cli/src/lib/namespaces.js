const { capture } = require('./exec');
const { isNotFound, isAlreadyExists, firstLine } = require('./kubeErrors');

const MANAGED_LABEL = 'localctl.dev/managed';
const APP_ANNOTATION = 'localctl.dev/app';

// Namespaces a config may never claim: Kubernetes' own, and the ones localctl's addons use.
const RESERVED_NAMESPACES = ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'observability', 'cert-manager', 'traefik', 'ingress-nginx', 'localctl'];

// Also anything starting with kube-, and the common cluster add-ons, which a config has no business
// deploying into.
const RESERVED_PATTERN = /^kube-/;
const isReservedNamespace = (ns) => RESERVED_NAMESPACES.includes(ns) || RESERVED_PATTERN.test(ns);

// Creates a namespace that is marked as managed by localctl and records which app owns it, in one
// request, so there is no moment where it exists without an owner. Does nothing when it already
// exists: assertNamespaceOwnership decides whether that one may be used.
function ensureManagedNamespace(namespace, owner) {
  const existing = capture('kubectl', ['get', 'namespace', namespace, '--request-timeout=20s']);
  if (existing.status === 0) return;
  if (!isNotFound(existing.stderr, 'namespaces', namespace)) {
    throw new Error(`Couldn't check namespace "${namespace}": ${firstLine(existing.stderr || existing.stdout || 'kubectl failed')}`);
  }
  const manifest = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: { [MANAGED_LABEL]: 'true' },
      annotations: owner ? { [APP_ANNOTATION]: owner } : undefined,
    },
  };
  // `create` (not apply) fails if someone created it a moment ago instead of silently adopting it.
  const created = capture('kubectl', ['create', '-f', '-'], { input: JSON.stringify(manifest) });
  if (created.status !== 0 && !isAlreadyExists(created.stderr)) {
    throw new Error(`Couldn't create namespace "${namespace}": ${firstLine(created.stderr || created.stdout || 'kubectl failed')}`);
  }
  // If someone else created it first, what is there must be ours before anything goes into it.
  if (owner) assertNamespaceOwnership({ name: owner, namespace });
}

// Refuses to touch a namespace that exists but was not created by localctl for this app. Without
// this, a config that names `namespace: shop` could make `app up` overwrite objects in someone
// else's namespace and `app down` or `app prune` delete it. A namespace that doesn't exist yet is
// fine: it gets created, marked and annotated on first deploy. Any answer other than "found" or
// "not found" (API unreachable, no permission, odd output) is an error, never a pass.
function assertNamespaceOwnership(cfg) {
  const res = capture('kubectl', ['get', 'namespace', cfg.namespace, '-o', 'json', '--request-timeout=20s']);
  if (res.status !== 0) {
    if (isNotFound(res.stderr, 'namespaces', cfg.namespace)) return;
    throw new Error(`Couldn't check whether namespace "${cfg.namespace}" is yours: ${firstLine(res.stderr || res.stdout || 'kubectl failed')}`);
  }
  let meta;
  try {
    meta = JSON.parse(res.stdout).metadata;
  } catch (e) {
    meta = null;
  }
  if (!meta || typeof meta !== 'object') {
    throw new Error(`Couldn't read namespace "${cfg.namespace}" from the cluster, so it won't be touched.`);
  }
  if (meta.deletionTimestamp) {
    throw new Error(`Namespace "${cfg.namespace}" is being deleted; wait a moment and try again.`);
  }
  const labels = meta.labels || {};
  const owner = (meta.annotations || {})[APP_ANNOTATION];
  if (labels[MANAGED_LABEL] !== 'true') {
    throw new Error(
      `Namespace "${cfg.namespace}" already exists and wasn't created by localctl, so it won't be touched. ` +
      `Pick another "namespace" in .local/config.yaml, or if it is yours: kubectl label namespace ${cfg.namespace} ${MANAGED_LABEL}=true && ` +
      `kubectl annotate namespace ${cfg.namespace} ${APP_ANNOTATION}=${cfg.name}`,
    );
  }
  if (owner !== cfg.name) {
    throw new Error(
      owner
        ? `Namespace "${cfg.namespace}" belongs to the app "${owner}", not "${cfg.name}". Use a different "namespace" so the two apps stay apart.`
        : `Namespace "${cfg.namespace}" is managed by localctl but has no owner recorded. Claim it with: kubectl annotate namespace ${cfg.namespace} ${APP_ANNOTATION}=${cfg.name}`,
    );
  }
}

module.exports = { ensureManagedNamespace, assertNamespaceOwnership, isReservedNamespace, RESERVED_NAMESPACES, MANAGED_LABEL, APP_ANNOTATION };
