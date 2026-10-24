const { capture } = require('./exec');
const { DOMAIN } = require('./constants');
const { firstLine } = require('./kubeErrors');

// Host names are case-insensitive and may carry a trailing dot; compare them in one form.
const normalise = (host) => String(host).trim().toLowerCase().replace(/\.$/, '');

// A host an existing route serves is in the way of `mine` if it is the same name, or a wildcard
// (`*.local.test`) that covers it.
function covers(routeHost, mine) {
  const route = normalise(routeHost);
  if (route === mine) return true;
  return route.startsWith('*.') && mine.endsWith(route.slice(1));
}

function listObjects(resource, optional) {
  const res = capture('kubectl', ['get', resource, '-A', '-o', 'json', '--request-timeout=20s']);
  if (res.status !== 0) {
    const text = `${res.stderr || ''}${res.stdout || ''}`;
    // Traefik's own CRDs may not be installed: then there simply are no such routes.
    if (optional && /the server doesn't have a resource type "ingressroutes"|no matches for kind "IngressRoute"/i.test(text)) return [];
    throw new Error(`Couldn't check whether the hosts are already served by another app (${resource}): ${firstLine(text || 'kubectl failed')}`);
  }
  let items;
  try {
    items = JSON.parse(res.stdout).items;
  } catch (e) {
    items = null;
  }
  if (!Array.isArray(items)) throw new Error(`Couldn't read the list of ${resource} from the cluster.`);
  return items;
}

// Reads a Traefik rule such as  Host(`a.local.test`) || HostRegexp(`{sub:.+}.local.test`)  with a
// single linear pass (no regular expression that could backtrack on hostile input). Returns the
// literal hosts, and `regexps` for HostRegexp patterns, whose reach can't be worked out here.
function parseRule(rule) {
  const text = String(rule || '');
  const hosts = [];
  const regexps = [];
  let i = 0;
  while (i < text.length) {
    const m = /^(host|hostregexp)\s*\(/i.exec(text.slice(i, i + 24));
    const prev = i === 0 ? ' ' : text[i - 1];
    if (!m || /[A-Za-z0-9_]/.test(prev)) {
      i += 1;
      continue;
    }
    const target = m[1].toLowerCase() === 'host' ? hosts : regexps;
    i += m[0].length;
    // Arguments up to the closing parenthesis, each quoted with ` " or '.
    while (i < text.length && text[i] !== ')') {
      const quote = text[i];
      if (quote === '`' || quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        if (end === -1) { i = text.length; break; }
        target.push(text.slice(i + 1, end));
        i = end + 1;
      } else {
        i += 1;
      }
    }
  }
  return { hosts, regexps };
}

// Could a HostRegexp pattern reach `mine`? It names the domain, or is a catch-all (no literal
// domain at all, like `.*`). Anything else is a pattern for some other domain.
function regexpMayCover(pattern, mine) {
  const p = String(pattern).toLowerCase();
  if (p.includes(DOMAIN.toLowerCase()) || p.includes(mine)) return true;
  return !/[a-z0-9]\.[a-z]{2,}/.test(p.replace(/\\\./g, '.'));
}

// Stops an app from taking over a host another app already serves: two routes for the same host
// would fight over it in Traefik, and a config could use that to shadow another app. Looks at the
// objects in the cluster (the source of truth, unlike a local registry that can go stale): Ingress
// objects, including wildcard hosts, and Traefik IngressRoutes. Anything other than a clean answer
// is an error.
function assertHostsFree(cfg) {
  const mine = cfg.hosts.map((h) => normalise(`${h}.${DOMAIN}`));
  const claims = [];
  for (const ing of listObjects('ingress', false)) {
    const meta = ing.metadata || {};
    for (const rule of (ing.spec && ing.spec.rules) || []) {
      if (rule && rule.host) claims.push({ host: rule.host, namespace: meta.namespace, name: `ingress ${meta.name}` });
    }
  }
  for (const route of listObjects('ingressroutes.traefik.io', true)) {
    const meta = route.metadata || {};
    for (const r of (route.spec && route.spec.routes) || []) {
      const { hosts, regexps } = parseRule(r && r.match);
      for (const host of hosts) claims.push({ host, namespace: meta.namespace, name: `ingressroute ${meta.name}` });
      for (const pattern of regexps) claims.push({ pattern, namespace: meta.namespace, name: `ingressroute ${meta.name}` });
    }
  }
  for (const claim of claims) {
    if (claim.namespace === cfg.namespace) continue;
    const clash = mine.find((h) => (claim.pattern !== undefined ? regexpMayCover(claim.pattern, h) : covers(claim.host, h)));
    if (clash) {
      const what = claim.pattern !== undefined ? `a HostRegexp pattern (${String(claim.pattern).slice(0, 60)})` : claim.host;
      throw new Error(`The host "${clash}" may already be served by ${claim.namespace}/${claim.name}: ${what}. Pick another "subdomain" or "ingress.hosts" entry in .local/config.yaml.`);
    }
  }
}

module.exports = { assertHostsFree, parseRule };
