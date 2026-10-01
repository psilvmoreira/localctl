const readline = require('readline');

// Deliberately not using rl.question() in a loop: with piped (non-TTY) stdin, all lines can
// arrive before a later rl.question() call attaches its listener, silently dropping answers.
// Async-iterating the readline interface instead queues lines correctly either way.
async function askAll(questions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const answers = [];
  let idx = 0;
  const prompt = (q) => process.stdout.write(`${q.text}${q.def ? ` (${q.def})` : ''}: `);

  prompt(questions[0]);
  for await (const line of rl) {
    answers.push(line.trim() || questions[idx].def);
    idx += 1;
    if (idx >= questions.length) break;
    prompt(questions[idx]);
  }
  rl.close();
  return answers;
}

// Same underlying fix as askAll, but for a wizard whose later questions depend on an earlier
// answer (so a fixed up-front question list won't do). Manually driving the readline interface's
// async iterator - rather than attaching a fresh 'line' listener per question - is what actually
// queues lines correctly under piped stdin; ad hoc listeners are what askAll's comment warns about.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const iterator = rl[Symbol.asyncIterator]();

  async function ask(text, def) {
    process.stdout.write(`${text}${def ? ` (${def})` : ''}: `);
    const { value, done } = await iterator.next();
    if (done) return def || '';
    return value.trim() || def || '';
  }

  return { ask, close: () => rl.close() };
}

// Same resolve-before-close ordering as the fix in the old uninstall.js confirm(): rl.close()
// synchronously re-enters the 'close' handler below, which would resolve('') first and win the
// race if this ran second. Shared now by `uninstall` and `app prune`.
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write(question);
    rl.on('line', (line) => {
      resolve(line.trim());
      rl.close();
    });
    rl.on('close', () => resolve(''));
  });
}

// Reads one line without echoing it back - for secret values, so they don't land in your shell's
// scrollback or a screen-share. Piped/non-TTY stdin (tests, CI) can't be hidden anyway, so it
// just falls back to a plain read there instead of failing.
function promptHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on('line', (line) => {
        resolve(line.trim());
        rl.close();
      });
      rl.on('close', () => resolve(''));
      process.stdout.write(`${question}: `);
      return;
    }

    process.stdout.write(`${question}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (char === '') process.exit(130); // Ctrl-C
      if (char === '' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    process.stdin.on('data', onData);
  });
}

module.exports = { askAll, makePrompter, confirm, promptHidden };
