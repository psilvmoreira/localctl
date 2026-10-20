// Cluster-wide observability addons (Prometheus/Grafana, Loki). They need several GB of memory,
// so they only run with --with-heavy, and are reported as skipped otherwise - never silently.
module.exports = function register(runner) {
  runner.add({
    id: 'cluster-addon-monitoring', group: 'heavy', needs: ['cluster-provision'], timeoutMs: 1200000,
    skipNote: 'needs several GB of memory: run with --with-heavy',
    title: 'the "monitoring" cluster addon enables, reports status and disables',
    run: async (t) => {
      t.cli(['addons', 'list']);
      t.cli(['addons', 'enable', 'monitoring'], { timeoutMs: 1200000 });
      t.contains(t.cli(['addons', 'status']).all, 'monitoring', 'addons status');
      t.cli(['addons', 'disable', 'monitoring'], { timeoutMs: 600000 });
    },
  });
};
