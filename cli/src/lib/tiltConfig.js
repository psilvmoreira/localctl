// What the Tiltfile needs from the app's config, already resolved (defaults applied, derived
// values computed). The Tiltfile reads this instead of parsing .local/config.yaml itself, so a new
// config field only needs a change here and never an edit to every app's generated Tiltfile.
function tiltConfig(cfg) {
  const portForwards = [`${cfg.port}:${cfg.port}`];
  if (cfg.debug.enabled && cfg.debug.port) portForwards.push(`${cfg.debug.port}:${cfg.debug.port}`);
  for (const extra of cfg.ports) {
    if (extra.forward && extra.protocol === 'TCP') portForwards.push(`${extra.port}:${extra.port}`);
  }
  return {
    name: cfg.name,
    build: {
      context: cfg.build.context,
      dockerfile: cfg.build.dockerfile,
      target: cfg.build.target || '',
      args: cfg.build.args,
      ignore: cfg.build.ignore,
    },
    sync: cfg.sync.map((s) => ({ localPath: s.localPath, remotePath: s.remotePath })),
    run: cfg.run.map((r) => ({ command: r.command, trigger: r.trigger || [] })),
    portForwards,
  };
}

module.exports = { tiltConfig };
