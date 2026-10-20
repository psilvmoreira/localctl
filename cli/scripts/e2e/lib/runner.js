// A deliberately tiny test runner: tests run one after another, in registration order. A test can
// declare `needs: [ids]`; if any of those didn't pass, it is SKIPPED (with the reason) rather
// than failing for a cause that was already reported. Every command a test runs, and its full
// output, goes to that test's own log file - the report points at it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Runner {
  constructor({ logDir, env, shared }) {
    this.logDir = logDir;
    this.env = env;
    this.shared = shared; // values tests hand to each other (ports, app dirs, ...)
    this.defs = [];
    this.results = [];
  }

  add(def) {
    this.defs.push({ needs: [], group: 'misc', timeoutMs: 120000, ...def });
  }

  statusOf(id) {
    const r = this.results.find((x) => x.id === id);
    return r ? r.status : 'missing';
  }

  makeTestApi(def, lines) {
    const log = (msg) => lines.push(msg);
    const exec = (label, cmd, args, opts = {}) => {
      const shown = [cmd, ...args].join(' ');
      log(`$ ${shown}${opts.cwd ? `   (cwd: ${opts.cwd})` : ''}`);
      const res = spawnSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || this.env,
        input: opts.input,
        encoding: 'utf8',
        timeout: opts.timeoutMs || def.timeoutMs,
      });
      const out = {
        status: res.error ? -1 : res.status,
        stdout: (res.stdout || '').trim(),
        stderr: (res.stderr || '').trim(),
      };
      out.all = [out.stdout, out.stderr].filter(Boolean).join('\n');
      if (res.error) log(`!! failed to run: ${res.error.message}`);
      if (out.stdout) log(out.stdout);
      if (out.stderr) log(`[stderr] ${out.stderr}`);
      log(`-> exit ${out.status}`);
      if (out.status !== 0 && !opts.allowFail) {
        const tail = out.all.split('\n').slice(-12).join('\n');
        const err = new Error(`${label} failed (exit ${out.status}): ${shown}\n${tail}`);
        err.expected = true;
        throw err;
      }
      return out;
    };

    const t = {
      log,
      assert,
      shared: this.shared,
      env: this.env,
      cli: (args, opts) => exec('localctl', process.execPath, [require('./context').BIN, ...args], opts),
      sh: (cmd, args = [], opts) => exec(cmd, cmd, args, opts),
      kubectl: (args, opts) => exec('kubectl', 'kubectl', args, opts),
      contains(haystack, needle, what) {
        if (!String(haystack).includes(needle)) {
          const e = new Error(`expected ${what || 'output'} to contain "${needle}"\n--- got ---\n${String(haystack).slice(0, 600)}`);
          e.expected = true;
          throw e;
        }
      },
      // Re-runs `fn` until it returns truthy (or doesn't throw), for things that settle over time.
      async poll(desc, fn, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
        const start = Date.now();
        let last = '';
        for (;;) {
          try {
            const v = await fn();
            if (v || v === undefined) return v;
            last = 'condition false';
          } catch (e) {
            last = e.message.split('\n')[0];
          }
          if (Date.now() - start > timeoutMs) {
            log(`!! gave up waiting for: ${desc} (${last})`);
            const e = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${desc} (last: ${last})`);
            e.expected = true;
            throw e;
          }
          await sleep(intervalMs);
        }
      },
    };
    return t;
  }

  async runAll({ only, skipGroups, onResult, onStart }) {
    for (const def of this.defs) {
      const base = { id: def.id, group: def.group, title: def.title };
      let result;
      const skipReason = this.skipReason(def, { only, skipGroups });
      if (skipReason) {
        result = { ...base, status: 'skipped', reason: skipReason, ms: 0 };
      } else {
        if (onStart) onStart(def);
        const lines = [];
        const t = this.makeTestApi(def, lines);
        const start = Date.now();
        try {
          await def.run(t);
          result = { ...base, status: 'passed' };
        } catch (e) {
          lines.push(`!! ${e.message}`);
          if (!e.expected && e.stack) lines.push(e.stack);
          result = { ...base, status: 'failed', error: e.message };
        }
        result.ms = Date.now() - start;
        result.logFile = path.join(this.logDir, `${def.id}.log`);
        fs.writeFileSync(result.logFile, `# ${def.id} - ${def.title}\n# ${result.status}\n\n${lines.join('\n')}\n`);
      }
      this.results.push(result);
      if (onResult) onResult(result);
    }
    return this.results;
  }

  skipReason(def, { only, skipGroups }) {
    if (only && !only.includes(def.id)) return 'not selected (--only)';
    if (skipGroups.has(def.group)) return def.skipNote || `group "${def.group}" skipped`;
    for (const need of def.needs) {
      const s = this.statusOf(need);
      if (s !== 'passed') return `depends on "${need}" which ${s === 'skipped' ? 'was skipped' : s}`;
    }
    return null;
  }
}

module.exports = { Runner, sleep };
