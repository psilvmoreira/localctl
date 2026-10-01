module.exports = {
  // The "default" profile's cluster name - the single cluster this whole tool managed before
  // multi-project support existed. Other Main-level projects get their own `local-dev-<name>`
  // cluster (see profileStore.js).
  DEFAULT_CLUSTER_NAME: 'local-dev',
  DEFAULT_HTTP_PORT: 80,
  DEFAULT_HTTPS_PORT: 443,
  // .test (RFC 2606) is reserved for testing and guaranteed to never resolve publicly or be
  // HSTS-preloaded. Not .dev: it's a real, live gTLD (Google-operated) that's HSTS-preloaded at
  // the TLD level - every browser force-HTTPS's *any* .dev domain, including made-up ones, with
  // no way to click through a self-signed cert warning, and "local.dev" itself is registered by
  // an unrelated third party.
  DOMAIN: 'local.test',
  REGISTRY_HOST_PORT: '5050',
  OBSERVABILITY_NAMESPACE: 'observability',
};
