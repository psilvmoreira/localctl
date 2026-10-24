const fs = require('fs');
const os = require('os');
const path = require('path');

// The folder a config's relative paths may reach: the nearest ancestor of the app that holds a
// `.git`, so a monorepo can use `context: ..` for a shared folder, but never leave the repository.
// Without a git repository it is the app folder itself. A `.git` in the home directory (a dotfiles
// repo) is not a project root, or every app under $HOME would be allowed to reach all of it.
function projectRoot(appDir) {
  const app = fs.realpathSync(appDir);
  let home = null;
  try { home = fs.realpathSync(os.homedir()); } catch (e) { /* no home: nothing to exclude */ }
  let dir = app;
  for (let i = 0; i < 12; i += 1) {
    if (dir === home) break;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return app;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// Resolves `value` from `base` the way the filesystem would: every symlink is followed as it is
// met, so `link/..` goes to the parent of the link's TARGET (not of the link), and a path that
// does not exist yet is judged by its deepest existing ancestor. A dangling symlink is an error.
function physicalResolve(base, value) {
  let current = fs.realpathSync(base);
  // On POSIX a backslash is an ordinary character in a file name, so only `/` separates there.
  for (const segment of value.split(path.sep === '\\' ? /[\\/]+/ : /\/+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    let info = null;
    try { info = fs.lstatSync(next); } catch (e) { info = null; }
    if (!info) {
      current = next; // does not exist yet: keep going lexically from here
      continue;
    }
    try {
      current = fs.realpathSync(next);
    } catch (e) {
      throw new Error(`"${value}" goes through a symbolic link that points nowhere (${segment}).`);
    }
  }
  return current;
}

// build.context, build.dockerfile and sync[].localPath are resolved from the app folder and must
// stay inside the project. `..` is allowed only as far as the repository root.
function assertPathsInsideProject(cfg, appDir) {
  const root = projectRoot(appDir);
  const entries = [
    ['build.context', cfg.build.context],
    ['build.dockerfile', cfg.build.dockerfile],
    ...cfg.sync.map((s, i) => [`sync.${i}.localPath`, s.localPath]),
  ];
  for (const [field, value] of entries) {
    let resolved;
    try {
      resolved = physicalResolve(appDir, value);
    } catch (e) {
      throw new Error(`${field}: ${e.message}`);
    }
    if (!isInside(root, resolved)) {
      throw new Error(`${field} "${value}" points outside the project (${root}). Paths can go up with ".." only as far as the repository root.`);
    }
  }
}

module.exports = { assertPathsInsideProject, projectRoot };
