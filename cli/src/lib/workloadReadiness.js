const { capture } = require('./exec');

function getList(args) {
  const res = capture('kubectl', [...args, '-o', 'json']);
  if (res.status !== 0) return [];
  try {
    return JSON.parse(res.stdout).items || [];
  } catch (e) {
    return [];
  }
}

// Deployment/StatefulSet/DaemonSet all expose ready/desired counts, just under slightly
// different field names depending on kind.
function readyCounts(workload) {
  const status = workload.status || {};
  const ready = status.readyReplicas ?? status.numberReady ?? 0;
  const desired = (workload.spec || {}).replicas ?? status.desiredNumberScheduled ?? 0;
  return { ready, desired };
}

// Every workload (any kind) in a namespace whose name starts with `prefix`, with ready/desired
// counts - used to summarize a release's health without needing to know in advance which
// workload kind(s) the underlying Helm chart happens to use (this is exactly the fragility that
// bit `localctl status`'s dependency listing once already: Bitnami's Postgres/Redis charts use a
// StatefulSet, not the Deployment a hand-rolled addon would have used).
function workloadsWithPrefix(namespace, prefix) {
  const kinds = ['deployment', 'statefulset', 'daemonset'];
  return kinds
    .flatMap((kind) => getList(['get', kind, '-n', namespace]))
    .filter((w) => w.metadata.name.startsWith(prefix))
    .map((w) => ({ name: w.metadata.name, ...readyCounts(w) }));
}

module.exports = { getList, readyCounts, workloadsWithPrefix };
