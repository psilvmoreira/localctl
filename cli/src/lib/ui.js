const chalk = require('chalk');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(str) {
  return String(str).replace(ANSI_RE, '').length;
}

function padVisible(str, width) {
  const pad = Math.max(0, width - visibleLength(str));
  return str + ' '.repeat(pad);
}

// Column widths computed from visible (non-ANSI) length, so colored cells still line up.
function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i])), 0),
  );
  console.log(headers.map((h, i) => padVisible(chalk.bold(h), widths[i])).join('  ').trimEnd());
  rows.forEach((row) => {
    console.log(row.map((cell, i) => padVisible(String(cell), widths[i])).join('  ').trimEnd());
  });
}

const ok = (s) => chalk.green(s);
const warn = (s) => chalk.yellow(s);
const dim = (s) => chalk.gray(s);

// `ready`/`desired` replica counts -> a colored "x/y" string. Used anywhere a workload's
// readiness is summarized (app status, addon status) so the coloring rule stays in one place.
function readyLabel(ready, desired) {
  const text = `${ready}/${desired}`;
  return ready >= desired && desired > 0 ? ok(text) : warn(text);
}

module.exports = {
  printTable,
  visibleLength,
  padVisible,
  readyLabel,
  ok,
  warn,
  err: (s) => chalk.red(s),
  dim,
  bold: (s) => chalk.bold(s),
  url: (s) => chalk.cyan.underline(s),
  check: chalk.green('✔'),
  cross: chalk.red('✖'),
};
