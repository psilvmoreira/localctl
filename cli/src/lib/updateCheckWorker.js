// Background half of updateCheck.js: fetches the package's npm dist-tags and caches them. Runs
// detached, so it may outlive the command that started it; every failure is swallowed.
const fs = require('fs');
const path = require('path');
const https = require('https');

const [cachePath, packageName] = process.argv.slice(2);

function write(data) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data));
  } catch {
    // Nothing useful to do - the next command simply tries again.
  }
}

let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
} catch {
  // No cache yet.
}

// Record the attempt up front, so a slow or failing registry is retried tomorrow, not on every
// command in between.
write({ ...previous, checkedAt: Date.now() });

const req = https.get(`https://registry.npmjs.org/-/package/${packageName}/dist-tags`, { timeout: 5000 }, (res) => {
  if (res.statusCode !== 200) {
    res.resume();
    return;
  }
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      write({ checkedAt: Date.now(), distTags: JSON.parse(body) });
    } catch {
      // Malformed response - keep the previous cache.
    }
  });
});
req.on('timeout', () => req.destroy());
req.on('error', () => {});
