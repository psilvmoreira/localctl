#!/usr/bin/env node
// localctl end-to-end suite - one command:  npm run test:e2e
//
//   --yes, -y         don't ask before stopping your running clusters
//   --skip <groups>   comma-separated groups to skip (cluster, app-lifecycle, projects, addons, ...)
//   --only <ids>      comma-separated test ids
//   --offline-only    only the tests that need no cluster (nothing of yours is stopped)
//   --with-heavy      also run the memory-hungry cluster addon tests
//   --keep-cluster    leave the test cluster (localctl-e2e) up afterwards, to poke at it
//   --keep-artifacts  keep the throwaway state directory (hosts file, kubeconfig, app copies)
//   --restore         just put back what the last run stopped, then exit
//   --restore-after   restore without asking at the end (for non-interactive use)
//   --list            list the tests and exit
//
// What it does, in order: checks the machine -> snapshots what you have running -> runs the tests
// that need no cluster -> STOPS your other clusters (stop, never delete: volumes untouched) ->
// creates its own cluster and runs the rest -> removes only its own cluster -> prints the report
// -> asks whether to start your clusters and apps again.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const chalk = require('chalk');

// Tools localctl downloaded itself (Linux/Windows) live in ~/.localctl/tools; the CLI adds them to
// PATH on every run, and so must this runner.
require('../../src/lib/toolInstall').addToolsDirToPath();
const { commandExists, getFreePort } = require('../../src/lib/exec');
const { detectEngine } = require('../../src/lib/engine');
const pkg = require('../../package.json');
const ctx = require('./lib/context');
const { Runner } = require('./lib/runner');
const safety = require('./lib/safety');
const { printSummary, writeReport } = require('./lib/report');

const NOT_COVERED = [
  '"localctl setup": it provisions the default project, i.e. YOUR local-dev cluster. The cluster creation code it uses is covered by "profiles switch".',
  '"localctl uninstall": destructive and machine-wide (Podman VM registry trust, certificates). Run it by hand on a disposable machine.',
  'bin/bootstrap.sh and bin/uninstall.sh: shell installers, covered by the containerised Linux checks in docs/contributing.md.',
  '"localctl app up --foreground": interactive Tilt UI.',
  'Debug port forwarding and live-sync into a running container.',
];

function parseArgs(argv) {
  const o = { yes: false, skip: new Set(), only: null, offlineOnly: false, heavy: false, keepCluster: false, restore: false, restoreAfter: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--skip') { i += 1; argv[i].split(',').forEach((g) => o.skip.add(g.trim())); }
    else if (a === '--only') o.only = argv[(i += 1)].split(',').map((s) => s.trim());
    else if (a === '--offline-only') o.offlineOnly = true;
    else if (a === '--with-heavy') o.heavy = true;
    else if (a === '--keep-cluster') o.keepCluster = true;
    else if (a === '--keep-artifacts') o.keepArtifacts = true;
    else if (a === '--restore') o.restore = true;
    else if (a === '--restore-after') o.restoreAfter = true;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 17).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }
    else { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  return o;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

const step = (m) => console.log(`${chalk.cyan('▸')} ${m}`);
const warn = (m) => console.log(`${chalk.yellow('!')} ${m}`);

function preflight(opts) {
  const problems = [];
  if (process.platform === 'win32') problems.push('The e2e suite supports macOS and Linux (it uses a POSIX shell shim).');
  ['k3d', 'kubectl', 'tilt', 'mkcert', 'helm', 'curl'].forEach((c) => {
    if (!commandExists(c)) problems.push(`"${c}" is not installed. Run "localctl setup" first.`);
  });
  const engine = detectEngine();
  if (!engine) problems.push('No running container engine (Docker/Podman). Start it and re-run.');
  return { problems, engine };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  if (opts.restore) {
    const snap = safety.pendingSnapshot();
    if (!snap) { console.log('Nothing pending - everything an earlier run stopped has already been restored.'); return 0; }
    step(`Restoring from ${snap.file || 'latest snapshot'}`);
    safety.describe(snap).forEach((l) => console.log(`  ${l}`));
    const res = safety.restore(snap, (m) => console.log(`  ${m}`));
    if (res.every((r) => r.ok)) safety.markRestored();
    return res.every((r) => r.ok) ? 0 : 1;
  }

  const { problems, engine } = preflight(opts);
  if (problems.length) {
    console.error(chalk.red('Cannot run the e2e suite:'));
    problems.forEach((p) => console.error(`  - ${p}`));
    return 2;
  }
  const engineBin = engine.bin;

  // ---- throwaway world -------------------------------------------------------------------
  const ws = ctx.createWorkspace();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportBase = process.env.LOCALCTL_E2E_REPORT_DIR || path.join(ctx.CLI_DIR, '.e2e-reports');
  const reportDir = path.join(reportBase, stamp);
  const logDir = path.join(reportDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  if (safety.leftoverTestCluster()) {
    warn(`A test cluster (${ctx.CLUSTER}) from an earlier crashed run is still there; removing it.`);
    safety.teardownTestCluster(engineBin, ws.kubeconfig, () => {});
  }
  const ports = { httpPort: await getFreePort(), httpsPort: await getFreePort(), registryPort: ctx.REGISTRY_PORT };
  if (!(await portFree(ports.registryPort))) {
    console.error(chalk.red(`Port ${ports.registryPort} (the test registry) is in use by something else; free it and re-run.`));
    return 2;
  }
  ctx.seedProfiles(ws, ports);

  const skipGroups = new Set(opts.skip);
  if (!opts.heavy) skipGroups.add('heavy');
  if (opts.offlineOnly) ['cluster', 'app-lifecycle', 'addons', 'heavy', 'setup'].forEach((g) => skipGroups.add(g));
  const needsCluster = !skipGroups.has('cluster') && !opts.list;

  // ---- what is running now ---------------------------------------------------------------
  // Something an earlier run stopped and that was never started again counts as "yours" too.
  const pending = safety.pendingSnapshot();
  const snapshot = safety.mergeSnapshots(safety.takeSnapshot(engineBin), pending);
  const snapshotFile = needsCluster ? safety.saveSnapshot(snapshot) : null;
  if (needsCluster && pending) warn(`Including what an earlier run left stopped (${pending.file}).`);
  console.log(chalk.bold(`\nlocalctl end-to-end suite  (${pkg.version}, ${process.platform}, engine: ${engine.engine})`));
  console.log(chalk.dim(`isolated state: ${ws.root}\nreport + logs : ${reportDir}\n`));

  if (needsCluster) {
    const lines = safety.describe(snapshot);
    if (lines.length) {
      step('Currently running (will be STOPPED, not deleted, and offered back at the end):');
      lines.forEach((l) => console.log(`    ${l}`));
      console.log(chalk.dim(`    snapshot saved: ${snapshotFile}`));
      console.log(chalk.dim('    "stop" keeps every volume, image and deployment as it is.\n'));
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error(chalk.red('Refusing to stop your clusters non-interactively. Re-run with --yes, or use --offline-only.'));
          fs.rmSync(ws.root, { recursive: true, force: true });
          return 2;
        }
        const a = await safety.ask('Stop them and run the suite? [y/N] ');
        if (!/^y(es)?$/i.test(a)) {
          console.log('Aborted. Nothing was changed.');
          fs.rmSync(ws.root, { recursive: true, force: true });
          return 0;
        }
      }
    } else {
      step('Nothing else is running - nothing to stop.');
    }
  }

  // ---- register tests --------------------------------------------------------------------
  const runner = new Runner({ logDir, env: ctx.envFor(ws), shared: { ports } });
  const deps = { ws, engineBin };
  require('./tests/offline')(runner, deps);

  runner.add({
    id: 'machine-prepare', group: 'setup', timeoutMs: 600000,
    title: 'your running clusters are stopped to free memory (nothing deleted)',
    run: async (t) => {
      const log = (m) => t.log(m);
      safety.stopOthers(snapshot, log);
      const still = safety.takeSnapshot(engineBin);
      t.assert.deepStrictEqual(still.clusters, [], `still running: ${still.clusters.join(', ')}`);
    },
  });
  // cluster-provision (registered in cluster.js) must not run unless the machine was prepared.
  require('./tests/cluster')(runner, deps);
  runner.defs.find((d) => d.id === 'cluster-provision').needs.push('machine-prepare');
  require('./tests/addons')(runner, deps);
  require('./tests/heavy')(runner, deps);

  if (opts.list) {
    runner.defs.forEach((d) => console.log(`${d.id.padEnd(30)} ${d.group.padEnd(14)} ${d.title}`));
    fs.rmSync(ws.root, { recursive: true, force: true });
    fs.rmSync(reportDir, { recursive: true, force: true });
    return 0;
  }

  // ---- run -------------------------------------------------------------------------------
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });

  let results;
  try {
    results = await runner.runAll({
      only: opts.only,
      skipGroups,
      onStart: (d) => process.stdout.write(chalk.dim(`  … ${d.title}\r`)),
      onResult: (r) => {
        const icon = { passed: chalk.green('✔'), failed: chalk.red('✖'), skipped: chalk.yellow('⊘') }[r.status];
        process.stdout.write('\x1b[2K');
        console.log(`  ${icon} ${r.title}${r.status === 'failed' ? chalk.red('  FAILED') : ''}`);
      },
    });
  } finally {
    // Diagnostics from the cluster, while it still exists, so a failure can be understood later.
    if (needsCluster && results && results.some((r) => r.status === 'failed')) {
      const diag = path.join(logDir, '_cluster-diagnostics.log');
      const sh = (cmd, args) => safety.sh(cmd, args, { env: { ...process.env, KUBECONFIG: ws.kubeconfig } });
      const parts = [
        ['pods', sh('kubectl', ['get', 'pods', '-A', '-o', 'wide']).stdout],
        ['events', sh('kubectl', ['get', 'events', '-A', '--sort-by=.lastTimestamp']).stdout.split('\n').slice(-60).join('\n')],
        ['containers', sh(engineBin, ['ps', '-a', '--format', '{{.Names}}  {{.Status}}']).stdout],
      ];
      fs.writeFileSync(diag, parts.map(([k, v]) => `### ${k}\n${v}\n`).join('\n'));
    }
    if (needsCluster && !opts.keepCluster) safety.teardownTestCluster(engineBin, ws.kubeconfig, (m) => console.log(chalk.dim(`  ${m}`)));
    else if (opts.keepCluster) warn(`Test cluster left running. Remove it with: k3d cluster delete ${ctx.CLUSTER}`);
  }

  // ---- report ----------------------------------------------------------------------------
  const meta = {
    startedAt: startedAt.toISOString(), totalMs: Date.now() - startedAt.getTime(),
    platform: `${process.platform} ${os.arch()}`, engine: engine.engine, version: pkg.version,
  };
  const counts = writeReport({ results, notCovered: NOT_COVERED, reportDir, meta });
  printSummary({ results, notCovered: NOT_COVERED, reportDir, meta });
  if (!opts.keepArtifacts) fs.rmSync(ws.root, { recursive: true, force: true });

  // ---- give your machine back ------------------------------------------------------------
  if (needsCluster && describeNonEmpty(snapshot)) {
    console.log('');
    step('These were running before the tests and are currently stopped:');
    safety.describe(snapshot).forEach((l) => console.log(`    ${l}`));
    let doRestore = opts.restoreAfter;
    if (!doRestore && process.stdin.isTTY && !interrupted) {
      const a = await safety.ask('\nStart all of them again now (clusters, registries and apps)? [Y/n] ');
      doRestore = !/^n(o)?$/i.test(a);
    }
    if (doRestore) {
      step('Restoring...');
      const res = safety.restore(snapshot, (m) => console.log(`  ${m}`));
      const bad = res.filter((r) => !r.ok);
      if (!bad.length) safety.markRestored();
      console.log(bad.length ? chalk.yellow(`\n${bad.length} item(s) need a manual look (see above).`) : chalk.green('\nEverything is back up.'));
    } else {
      console.log(chalk.bold('\nNot restored. Whenever you want them back:'));
      console.log(chalk.cyan('    npm run test:e2e -- --restore'));
    }
  }
  return counts.failed > 0 ? 1 : 0;
}

function describeNonEmpty(s) {
  return s.clusters.length + s.registries.length + s.tilt.length + s.apps.length > 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(chalk.red(`e2e runner crashed: ${e.stack || e}`));
  console.error('Your clusters may be stopped. Put them back with: npm run test:e2e -- --restore');
  process.exit(2);
});
