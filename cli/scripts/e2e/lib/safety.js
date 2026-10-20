// Protects what you already have running. The e2e suite needs the machine's memory (a second k3s
// cluster does not fit next to yours on a small VM), so before testing it:
//   1. records everything that is up - clusters, their registries, and the background dev loops
//      (`localctl app up`) with the directory each runs in - into a snapshot file,
//   2. STOPS (never deletes) them: `k3d cluster stop` and `<engine> stop` keep every volume,
//      image and deployment exactly as they were,
// and at the end offers to start it all again from that snapshot.
// Nothing here ever removes a cluster, container or volume that isn't named local-dev-e2e*.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');

const { HOME_STATE_DIR, RUN_DIR } = require('../../../src/lib/paths');
const { sleepSync, isRunning } = require('../../../src/lib/exec');
const { BIN, CLUSTER } = require('./context');

const SNAPSHOT_DIR = path.join(HOME_STATE_DIR, 'e2e');

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs || 120000, ...opts });
  return { status: res.error ? -1 : res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

function isOurs(name) {
  return name === CLUSTER || name.startsWith(`${CLUSTER}-`);
}

function processCwd(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch (e) {
      return null;
    }
  }
  const res = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = res.stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function listClusters() {
  const res = sh('k3d', ['cluster', 'list', '-o', 'json']);
  if (res.status !== 0) return [];
  try {
    return JSON.parse(res.stdout).map((c) => ({ name: c.name, running: (c.serversRunning || 0) > 0 }));
  } catch (e) {
    return [];
  }
}

function runningContainers(engineBin) {
  return sh(engineBin, ['ps', '--format', '{{.Names}}']).stdout.split('\n').filter(Boolean);
}

function runningTiltLoops() {
  if (!fs.existsSync(RUN_DIR)) return [];
  return fs.readdirSync(RUN_DIR)
    .filter((f) => f.endsWith('.pid'))
    .map((f) => ({ name: f.replace(/\.pid$/, ''), pid: parseInt(fs.readFileSync(path.join(RUN_DIR, f), 'utf8'), 10) }))
    .filter((p) => Number.isFinite(p.pid) && isRunning(p.pid))
    .map((p) => ({ ...p, cwd: processCwd(p.pid) }));
}

function deployedApps(clusterName) {
  const res = sh('kubectl', [
    '--context', `k3d-${clusterName}`, 'get', 'deployment', '-A',
    '-l', 'localctl.dev/managed=true', '-o', 'json',
  ]);
  if (res.status !== 0) return [];
  try {
    return JSON.parse(res.stdout).items.map((d) => ({ cluster: clusterName, namespace: d.metadata.namespace, name: d.metadata.name }));
  } catch (e) {
    return [];
  }
}

// What is up right now, excluding anything that belongs to this suite.
function takeSnapshot(engineBin) {
  const containers = runningContainers(engineBin);
  const clusters = listClusters().filter((c) => c.running && !isOurs(c.name));
  return {
    takenAt: new Date().toISOString(),
    engineBin,
    kubeContext: sh('kubectl', ['config', 'current-context']).stdout || null,
    clusters: clusters.map((c) => c.name),
    registries: containers.filter((n) => clusters.some((c) => n === `${c.name}-registry`)),
    tilt: runningTiltLoops(),
    apps: clusters.flatMap((c) => deployedApps(c.name)),
  };
}

const isEmpty = (s) => !s || s.clusters.length + s.registries.length + s.tilt.length + s.apps.length === 0;

// A snapshot of "nothing running" is never allowed to replace one that still has work to give
// back: running the suite twice (or after a crash) would otherwise forget what was stopped.
function saveSnapshot(snapshot) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `snapshot-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  if (!isEmpty(snapshot)) {
    fs.writeFileSync(path.join(SNAPSHOT_DIR, 'latest.json'), JSON.stringify({ ...snapshot, file }, null, 2));
  }
  return file;
}

function loadLatestSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'latest.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// What an earlier run stopped and nobody has started again yet.
function pendingSnapshot() {
  const s = loadLatestSnapshot();
  return s && !s.restoredAt && !isEmpty(s) ? s : null;
}

function markRestored() {
  const s = loadLatestSnapshot();
  if (!s) return;
  fs.writeFileSync(path.join(SNAPSHOT_DIR, 'latest.json'), JSON.stringify({ ...s, restoredAt: new Date().toISOString() }, null, 2));
}

function mergeSnapshots(current, pending) {
  if (!pending) return current;
  const uniq = (a, b, key = (x) => JSON.stringify(x)) => {
    const seen = new Set();
    return [...a, ...b].filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  return {
    ...current,
    kubeContext: pending.kubeContext || current.kubeContext,
    clusters: uniq(current.clusters, pending.clusters),
    registries: uniq(current.registries, pending.registries),
    tilt: uniq(current.tilt, pending.tilt, (t) => `${t.name}|${t.cwd}`),
    apps: uniq(current.apps, pending.apps, (a) => `${a.cluster}|${a.namespace}|${a.name}`),
  };
}

function describe(snapshot) {
  const lines = [];
  snapshot.clusters.forEach((c) => lines.push(`cluster  ${c}`));
  snapshot.registries.forEach((r) => lines.push(`registry ${r}`));
  snapshot.apps.forEach((a) => lines.push(`app      ${a.name} (namespace ${a.namespace}, cluster ${a.cluster})`));
  snapshot.tilt.forEach((t) => lines.push(`dev loop ${t.name} (pid ${t.pid}${t.cwd ? `, ${t.cwd}` : ''})`));
  return lines;
}

// Stops, never deletes. Order: dev loops first (so they don't fight a cluster that is going
// away), then clusters, then their registries.
function stopOthers(snapshot, log) {
  snapshot.tilt.forEach((t) => {
    log(`stopping dev loop ${t.name} (pid ${t.pid})`);
    try { process.kill(t.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
    for (let i = 0; i < 20 && isRunning(t.pid); i += 1) sleepSync(250);
  });
  snapshot.clusters.forEach((c) => {
    log(`stopping cluster ${c}`);
    const r = sh('k3d', ['cluster', 'stop', c], { timeoutMs: 300000 });
    if (r.status !== 0) log(`  ! ${r.stderr.split('\n').pop()}`);
  });
  snapshot.registries.forEach((n) => {
    log(`stopping registry ${n}`);
    sh(snapshot.engineBin, ['stop', n]);
  });
}

// Puts everything in the snapshot back. Returns [{what, ok, detail}] for the final message.
function restore(snapshot, log) {
  // Required lazily: these pull in the whole CLI, which a plain --list/--help run doesn't need.
  const { useClusterContext, waitForClusterApi } = require('../../../src/lib/clusterProvision');
  const results = [];
  const note = (what, ok, detail = '') => { results.push({ what, ok, detail }); log(`${ok ? 'ok ' : 'FAIL'} ${what}${detail ? ` - ${detail}` : ''}`); };

  snapshot.clusters.forEach((c) => {
    const started = sh('k3d', ['cluster', 'start', c, '--wait'], { timeoutMs: 300000 });
    snapshot.registries.filter((r) => r === `${c}-registry`).forEach((r) => sh(snapshot.engineBin, ['start', r]));
    if (started.status !== 0) {
      note(`cluster ${c}`, false, started.stderr.split('\n').pop());
      return;
    }
    useClusterContext(c);
    const ready = waitForClusterApi(snapshot.engineBin, c, { attempts: 60, quiet: true });
    note(`cluster ${c}`, ready, ready ? 'API ready' : 'started but the API did not answer in time');
  });

  snapshot.tilt.forEach((t) => {
    if (!t.cwd || !fs.existsSync(t.cwd)) {
      note(`dev loop ${t.name}`, false, 'its directory is unknown or gone - run "localctl app up" there yourself');
      return;
    }
    const r = sh(process.execPath, [BIN, 'app', 'up'], { cwd: t.cwd, timeoutMs: 300000 });
    note(`dev loop ${t.name}`, r.status === 0, r.status === 0 ? t.cwd : r.stderr.split('\n').pop());
  });

  snapshot.apps.forEach((a) => {
    const r = sh('kubectl', [
      '--context', `k3d-${a.cluster}`, 'rollout', 'status', `deployment/${a.name}`, '-n', a.namespace, '--timeout=120s',
    ], { timeoutMs: 150000 });
    note(`app ${a.name}`, r.status === 0, r.status === 0 ? 'ready' : 'not ready yet');
  });

  if (snapshot.kubeContext) sh('kubectl', ['config', 'use-context', snapshot.kubeContext]);
  return results;
}

// Removes ONLY what this suite created, by exact name.
function teardownTestCluster(engineBin, kubeconfig, log) {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const reg = `${CLUSTER}-registry`;
  log(`removing test cluster ${CLUSTER}`);
  sh('k3d', ['cluster', 'delete', CLUSTER], { env, timeoutMs: 300000 });
  sh(engineBin, ['rm', '-f', '-v', reg], { env });
  sh(engineBin, ['network', 'rm', `k3d-${CLUSTER}`], { env });
  sh(engineBin, ['volume', 'rm', `k3d-${CLUSTER}-images`], { env });
}

function leftoverTestCluster() {
  return listClusters().some((c) => isOurs(c.name));
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

module.exports = {
  takeSnapshot, saveSnapshot, loadLatestSnapshot, pendingSnapshot, markRestored, mergeSnapshots, describe, stopOthers, restore,
  teardownTestCluster, leftoverTestCluster, ask, sh, SNAPSHOT_DIR,
};
