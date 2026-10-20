#!/usr/bin/env node
// localctl end-to-end suite, on every supported Linux distribution - one command:
//   npm run test:e2e:distros
//
// For each distro it starts a throwaway PRIVILEGED container (nothing of yours is stopped: the
// container has its own network and its own Docker), where it installs Node and Docker the way a
// user on that distro would, runs `localctl setup`, `doctor`, and the whole e2e suite
// (scripts/e2e/run.js). Then it prints a distro x stage matrix with the error and log tail for
// anything that failed. macOS and Windows are not in here: they cannot be containerised.
//
//   --distros a,b     only these (default: all). See --list.
//   --addons          also run the addon tests (slow)
//   --keep-volumes    default; image caches (localctl-e2e-docker-*) survive for fast re-runs
//   --prune-volumes   delete those cache volumes at the end (only ones with that prefix)
//   --list            list the distros and exit
//   --timeout <min>   per-distro limit, default 40
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const chalk = require('chalk');

const { detectEngine } = require('../../src/lib/engine');
const { engineMemoryMb } = require('../../src/lib/podman');
const { CLI_DIR } = require('./lib/context');
const pkg = require('../../package.json');

const REPO_ROOT = path.resolve(CLI_DIR, '..');
const arm = process.arch === 'arm64';

// id -> image. Arch has no official arm64 image, so an ARM host uses the Arch Linux ARM one.
const DISTROS = {
  'ubuntu-24.04': { label: 'Ubuntu 24.04', image: 'docker.io/library/ubuntu:24.04' },
  'ubuntu-22.04': { label: 'Ubuntu 22.04', image: 'docker.io/library/ubuntu:22.04' },
  'debian-12': { label: 'Debian 12', image: 'docker.io/library/debian:12' },
  'fedora-41': { label: 'Fedora 41', image: 'docker.io/library/fedora:41' },
  'rocky-9': { label: 'Rocky Linux 9 (RHEL family)', image: 'docker.io/library/rockylinux:9' },
  'opensuse-leap-15.6': { label: 'openSUSE Leap 15.6', image: 'docker.io/opensuse/leap:15.6' },
  arch: { label: 'Arch Linux', image: arm ? 'docker.io/agners/archlinuxarm:latest' : 'docker.io/library/archlinux:latest' },
};
const STAGES = ['prereqs', 'node', 'dockerd', 'setup', 'doctor', 'e2e'];
// install-docker is informational: with no service manager in a container it installs the engine
// but cannot start it, so a non-zero exit there is expected. dockerd is the stage that counts.

function parseArgs(argv) {
  const o = { distros: Object.keys(DISTROS), addons: false, prune: false, list: false, timeoutMin: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distros') { i += 1; o.distros = argv[i].split(',').map((s) => s.trim()); }
    else if (a === '--addons') o.addons = true;
    else if (a === '--keep-volumes') o.prune = false;
    else if (a === '--prune-volumes') o.prune = true;
    else if (a === '--list') o.list = true;
    else if (a === '--timeout') { i += 1; o.timeoutMin = parseInt(argv[i], 10); }
    else { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  const unknown = o.distros.filter((d) => !DISTROS[d]);
  if (unknown.length) { console.error(`Unknown distro(s): ${unknown.join(', ')}. Known: ${Object.keys(DISTROS).join(', ')}`); process.exit(2); }
  return o;
}

// Stage results come from the per-stage .rc files the container writes as it goes, so a killed or
// timed-out container still reports what finished. 'running' means it was interrupted there.
function readStages(outDir) {
  const stages = {};
  STAGES.concat(['install-docker']).forEach((s) => {
    try {
      const v = fs.readFileSync(path.join(outDir, 'logs', `${s}.rc`), 'utf8').trim();
      stages[s] = v === 'running' ? 'interrupted' : parseInt(v, 10);
    } catch (e) { /* never started */ }
  });
  return stages;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

function latestE2eReport(dir) {
  try {
    const runs = fs.readdirSync(path.join(dir, 'e2e')).sort();
    return readJson(path.join(dir, 'e2e', runs[runs.length - 1], 'report.json'));
  } catch (e) {
    return null;
  }
}

function runContainer({ engineBin, id, spec, outDir, addons, timeoutMin }) {
  return new Promise((resolve) => {
    fs.mkdirSync(outDir, { recursive: true });
    const log = fs.createWriteStream(path.join(outDir, 'container.log'));
    const args = [
      'run', '--rm', '--privileged', '--name', `localctl-e2e-distro-${id}`,
      '-v', `${REPO_ROOT}:/repo:ro`,
      '-v', `${outDir}:/out`,
      // Docker's own storage on a volume (not the container's overlay), so overlay2 works and the
      // pulled images are cached between runs.
      '-v', `localctl-e2e-docker-${id}:/var/lib/docker`,
      '-e', `E2E_ARGS=${addons ? '' : '--skip addons'}`,
      spec.image, 'bash', '/repo/cli/scripts/e2e/container/run-in-container.sh',
    ];
    const child = spawn(engineBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = chalk.dim(`[${id}] `);
    const pipe = (stream) => stream.on('data', (d) => {
      log.write(d);
      d.toString().split('\n').filter(Boolean).forEach((l) => console.log(prefix + l));
    });
    pipe(child.stdout); pipe(child.stderr);
    const timer = setTimeout(() => { log.write('\n!! timed out\n'); spawnSync(engineBin, ['rm', '-f', `localctl-e2e-distro-${id}`]); }, timeoutMin * 60000);
    child.on('close', (code) => { clearTimeout(timer); log.end(); resolve(code); });
  });
}

const cell = (rc) => (rc === undefined ? chalk.dim('-') : rc === 'interrupted' ? chalk.yellow('…') : rc === 0 ? chalk.green('✔') : rc === -1 ? chalk.yellow('⊘') : chalk.red('✖'));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    Object.entries(DISTROS).forEach(([id, d]) => console.log(`${id.padEnd(20)} ${d.image}`));
    return 0;
  }
  if (process.platform === 'win32') { console.error('Run this from macOS or Linux.'); return 2; }
  const engine = detectEngine();
  if (!engine) { console.error(chalk.red('No running container engine (Docker/Podman).')); return 2; }
  const mem = engineMemoryMb(engine.bin);
  if (mem !== null && mem < 3500) {
    console.error(chalk.yellow(`The engine has ${(mem / 1024).toFixed(1)} GB. A cluster inside a container needs about 3.5 GB: ` +
      'with Podman run "podman machine set --memory 4096" (stop the machine first).'));
  }

  // A laptop that goes to sleep mid-run freezes the container engine's VM and every timeout then
  // fires on wake-up. caffeinate (macOS) keeps the machine awake for exactly as long as we run.
  if (process.platform === 'darwin') {
    const c = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(process.env.LOCALCTL_E2E_REPORT_DIR || path.join(CLI_DIR, '.e2e-reports'), `distros-${stamp}`);
  console.log(chalk.bold(`\nlocalctl e2e on Linux distributions  (${pkg.version}, engine: ${engine.engine})`));
  console.log(chalk.dim(`distros: ${opts.distros.join(', ')}\nreport : ${base}\n`));

  const started = Date.now();
  const rows = [];
  for (const id of opts.distros) {
    const spec = DISTROS[id];
    console.log(chalk.bold(`\n▸ ${spec.label}  (${spec.image})`));
    const outDir = path.join(base, id);
    const t0 = Date.now();
    const code = await runContainer({ engineBin: engine.bin, id, spec, outDir, addons: opts.addons, timeoutMin: opts.timeoutMin });
    const summary = { stages: readStages(outDir) };
    const e2e = latestE2eReport(outDir);
    rows.push({ id, spec, code, summary, e2e, ms: Date.now() - t0, outDir });
  }

  // ---- matrix ----------------------------------------------------------------------------
  console.log(`\n${chalk.bold('═'.repeat(86))}\n${chalk.bold(' localctl end-to-end on Linux distributions')}\n${chalk.bold('═'.repeat(86))}`);
  console.log(` ${'distro'.padEnd(30)}${STAGES.map((s) => s.padEnd(9)).join('')}tests`);
  let failed = 0;
  rows.forEach((r) => {
    const st = (r.summary && r.summary.stages) || {};
    const counts = r.e2e ? r.e2e.counts : null;
    const ok = STAGES.every((s) => st[s] === 0) && counts && counts.failed === 0;
    if (!ok) failed += 1;
    const tests = counts ? `${chalk.green(counts.passed)} pass / ${counts.failed ? chalk.red(counts.failed) : 0} fail / ${counts.skipped} skip` : chalk.dim('no report');
    console.log(` ${(ok ? chalk.green('✔ ') : chalk.red('✖ ')) + r.spec.label.padEnd(28)}${STAGES.map((s) => `${cell(st[s])}`.padEnd(9 + 9)).join('')}${tests}`);
  });

  rows.filter((r) => !(STAGES.every((s) => r.summary.stages[s] === 0) && r.e2e && r.e2e.counts.failed === 0)).forEach((r) => {
    console.log(`\n${chalk.red.bold(`✖ ${r.spec.label}`)}  ${chalk.dim(r.outDir)}`);
    const st = (r.summary && r.summary.stages) || {};
    STAGES.filter((s) => st[s] !== 0).forEach((s) => {
      const what = st[s] === undefined ? 'never started' : st[s] === 'interrupted' ? `INTERRUPTED (container ended: exit ${r.code}, likely timeout or out of memory)` : st[s] === -1 ? 'skipped' : `exit ${st[s]}`;
      console.log(`  stage ${chalk.bold(s)} ${what}`);
      const f = path.join(r.outDir, 'logs', `${s}.log`);
      if (fs.existsSync(f)) console.log(chalk.dim(fs.readFileSync(f, 'utf8').trim().split('\n').slice(-8).map((l) => `    | ${l}`).join('\n')));
    });
    if (r.e2e) {
      r.e2e.results.filter((t) => t.status === 'failed').forEach((t) => {
        console.log(`  test ${chalk.bold(t.title)}\n${chalk.red(t.error.split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'))}`);
      });
    }
    console.log(chalk.dim(`  full container output: ${path.join(r.outDir, 'container.log')}`));
  });

  fs.writeFileSync(path.join(base, 'matrix.json'), JSON.stringify(rows.map((r) => ({
    distro: r.id, image: r.spec.image, containerExit: r.code, seconds: Math.round(r.ms / 1000),
    stages: r.summary && r.summary.stages, tests: r.e2e && r.e2e.counts,
  })), null, 2));
  console.log(`\n${chalk.bold('─'.repeat(86))}\n ${rows.length - failed}/${rows.length} distributions fully green   (${Math.round((Date.now() - started) / 60000)} min)`);
  console.log(` Report + logs: ${base}\n${chalk.bold('─'.repeat(86))}`);

  if (opts.prune) {
    opts.distros.forEach((id) => spawnSync(engine.bin, ['volume', 'rm', '-f', `localctl-e2e-docker-${id}`]));
    console.log('Removed the localctl-e2e-docker-* cache volumes.');
  } else {
    console.log(chalk.dim('Docker image caches kept (localctl-e2e-docker-*) so re-runs are fast. Remove with --prune-volumes.'));
  }
  return failed ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(chalk.red(e.stack || e)); process.exit(2); });
