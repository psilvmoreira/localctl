const fs = require('fs');
const path = require('path');
const { readRegularFile } = require('./safeRead');

const MAX_ENV_FILE_BYTES = 256 * 1024;

const MAX_LINE_LENGTH = 8192;

// Drops a trailing ` # comment` from an unquoted value with a linear scan (a regex for this is
// quadratic on long runs of spaces).
function stripInlineComment(value) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === '#' && (value[i - 1] === ' ' || value[i - 1] === '\t')) return value.slice(0, i).trimEnd();
  }
  return value;
}

// Minimal dotenv parser: KEY=value lines, `#` comments, optional `export ` prefix, values may be
// wrapped in single or double quotes (anything after the closing quote is ignored). No variable
// expansion on purpose: values are used exactly as written.
function parseEnvFile(text) {
  const out = {};
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > MAX_LINE_LENGTH) throw new Error(`line ${index + 1} is longer than ${MAX_LINE_LENGTH} characters`);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) throw new Error(`line ${index + 1} is not KEY=value`);
    let value = m[2];
    const quote = value[0];
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    value = close > 0 ? value.slice(1, close) : stripInlineComment(value);
    if (m[1] === '__proto__') return;
    out[m[1]] = value;
  });
  return out;
}

// Reads `file` (relative to appDir). It has to stay inside the app folder, so a config from a
// repo you cloned can't point at ~/.aws/credentials or similar and pull its content into the
// container's environment.
function readEnvFile(appDir, file) {
  const root = fs.realpathSync(appDir);
  const resolved = path.resolve(root, file);
  if (!fs.existsSync(resolved)) throw new Error(`envFile "${file}" not found (looked in ${resolved}).`);
  const real = fs.realpathSync(resolved);
  const inside = path.relative(root, real);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`envFile "${file}" is outside the app folder; keep it inside ${root}.`);
  }
  try {
    return parseEnvFile(readRegularFile(real, MAX_ENV_FILE_BYTES, `envFile "${file}"`));
  } catch (e) {
    throw new Error(e.message.startsWith('envFile') ? e.message : `envFile "${file}": ${e.message}`);
  }
}

module.exports = { parseEnvFile, readEnvFile };
