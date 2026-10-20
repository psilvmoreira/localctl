// Turns the results into (1) the summary printed at the end of the run and (2) report.md /
// report.json next to the per-test logs, so a failure can be shared without re-running anything.
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const ICON = { passed: chalk.green('✔'), failed: chalk.red('✖'), skipped: chalk.yellow('⊘') };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function tailOf(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch (e) {
    return '(log not available)';
  }
}

function counts(results) {
  const c = { passed: 0, failed: 0, skipped: 0 };
  results.forEach((r) => { c[r.status] += 1; });
  return c;
}

function printSummary({ results, notCovered, reportDir, meta }) {
  const c = counts(results);
  console.log('\n' + chalk.bold('═'.repeat(72)));
  console.log(chalk.bold(' localctl end-to-end results'));
  console.log(chalk.bold('═'.repeat(72)));

  let group = null;
  results.forEach((r) => {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n ${chalk.bold.underline(group)}`);
    }
    const extra = r.status === 'skipped' ? chalk.dim(` - ${r.reason}`) : chalk.dim(` ${secs(r.ms)}`);
    console.log(`  ${ICON[r.status]} ${r.title}${extra}`);
  });

  const failures = results.filter((r) => r.status === 'failed');
  if (failures.length) {
    console.log('\n' + chalk.red.bold(' Failures'));
    failures.forEach((r) => {
      console.log(`\n  ${chalk.red('✖')} ${chalk.bold(r.title)} ${chalk.dim(`[${r.id}]`)}`);
      console.log(chalk.red(r.error.split('\n').map((l) => `      ${l}`).join('\n')));
      console.log(chalk.dim(`      log: ${r.logFile}`));
      console.log(chalk.dim(tailOf(r.logFile, 12).split('\n').map((l) => `      | ${l}`).join('\n')));
    });
  }

  if (notCovered.length) {
    console.log('\n' + chalk.yellow.bold(' Not covered by this suite (on purpose)'));
    notCovered.forEach((n) => console.log(`  - ${n}`));
  }

  console.log('\n' + chalk.bold('─'.repeat(72)));
  const line = `${chalk.green(`${c.passed} passed`)}, ${c.failed ? chalk.red(`${c.failed} failed`) : '0 failed'}, ${chalk.yellow(`${c.skipped} skipped`)}`;
  console.log(` ${line}   (${results.length} tests, ${secs(meta.totalMs)})`);
  console.log(` Report + logs: ${reportDir}`);
  console.log(chalk.bold('─'.repeat(72)));
  return c;
}

function writeReport({ results, notCovered, reportDir, meta }) {
  const c = counts(results);
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify({ meta, counts: c, notCovered, results }, null, 2));

  const md = [];
  md.push('# localctl end-to-end report', '');
  md.push(`- Started: ${meta.startedAt}`, `- Duration: ${secs(meta.totalMs)}`);
  md.push(`- Platform: ${meta.platform} / engine: ${meta.engine}`, `- localctl: ${meta.version}`, '');
  md.push(`**${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped**`, '');
  md.push('| | Group | Test | Time | Notes |', '|---|---|---|---|---|');
  results.forEach((r) => {
    const icon = { passed: '✅', failed: '❌', skipped: '⏭️' }[r.status];
    const note = r.status === 'skipped' ? r.reason : r.status === 'failed' ? `[log](logs/${r.id}.log)` : '';
    md.push(`| ${icon} | ${r.group} | ${r.title} | ${secs(r.ms)} | ${note} |`);
  });
  const failures = results.filter((r) => r.status === 'failed');
  if (failures.length) {
    md.push('', '## Failures', '');
    failures.forEach((r) => {
      md.push(`### ${r.title} (\`${r.id}\`)`, '', '```', r.error, '```', '', 'Last log lines:', '', '```', tailOf(r.logFile, 25), '```', '');
    });
  }
  if (notCovered.length) {
    md.push('', '## Not covered (on purpose)', '', ...notCovered.map((n) => `- ${n}`));
  }
  fs.writeFileSync(path.join(reportDir, 'report.md'), `${md.join('\n')}\n`);
  return c;
}

module.exports = { printSummary, writeReport, counts };
