const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
  return res;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

function commandExists(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [cmd], { stdio: 'ignore' });
  return res.status === 0;
}

// Blocking sleep with no native dependency - used for poll loops (e.g. waiting on a CRD to
// register) where an async setTimeout would need restructuring the whole command as a promise
// chain for no real benefit.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Starts a fully detached child that outlives this process (and the terminal it's running in) -
// used for `localctl up --detach`. stdout/stderr go to logFile since there's no terminal to
// inherit once the parent exits. Returns the child's pid.
function spawnDetached(cmd, args, { cwd, env, logFile } = {}) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

// True if a process with this pid is currently running (doesn't actually signal it).
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Asks the OS for a free TCP port (binds to port 0, reads back what it picked). Used to give each
// app's Tilt instance its own web UI port - Tilt otherwise always binds the same default port,
// so two apps running `localctl up` at once (the whole point of detached mode) collide outright,
// and the resulting error doesn't explain why.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { run, capture, commandExists, sleepSync, spawnDetached, isRunning, getFreePort };
