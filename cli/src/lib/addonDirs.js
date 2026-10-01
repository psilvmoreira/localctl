const fs = require('fs');
const os = require('os');
const path = require('path');

// Addons are searched in two places, in precedence order:
//   1. USER_DIR   - yours, never touched by a `localctl` update/reinstall. Defaults to
//                   ~/.localctl/addons, overridable via LOCALCTL_ADDONS_DIR (e.g. to point at a
//                   folder checked into your own infra repo instead).
//   2. BUILTIN_DIR - the addons shipped with this CLI (postgres/redis/mongo/cluster/logging).
// A user-dir addon of the same name replaces the built-in one; a new name just adds to the list.
// This is what lets someone install this tool without inheriting its author's addon set, and
// without forking the tool to add their own - see docs/adding-tools.md.
const BUILTIN_DIR = path.join(__dirname, 'addons');
const USER_DIR = process.env.LOCALCTL_ADDONS_DIR || path.join(os.homedir(), '.localctl', 'addons');

function roots(...segments) {
  return [path.join(USER_DIR, ...segments), path.join(BUILTIN_DIR, ...segments)];
}

// First matching addon.yaml wins - user dir searched before built-in.
function findAddonDir(name, ...segments) {
  for (const root of roots(...segments)) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'addon.yaml'))) return dir;
  }
  return null;
}

// Every addon name available across both locations, user-dir entries deduplicated against
// built-ins of the same name (a listing, not a "which one wins" answer - see findAddonDir for that).
function listAddonNames(...segments) {
  const names = new Set();
  for (const root of roots(...segments)) {
    if (!fs.existsSync(root)) continue;
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => fs.existsSync(path.join(root, e.name, 'addon.yaml')))
      .forEach((e) => names.add(e.name));
  }
  return [...names];
}

module.exports = { BUILTIN_DIR, USER_DIR, findAddonDir, listAddonNames };
