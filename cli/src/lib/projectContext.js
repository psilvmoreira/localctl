const fs = require('fs');
const path = require('path');

// Same lookup shape as git finding .git, or Claude finding .claude: walk up from a directory
// looking for the nearest `.local/project.json`, at that directory or any ancestor. This lets a
// single project.json at a parent folder govern every app subfolder underneath it, or a single
// `.local` folder hold both the project.json and an app's own config.json together - whichever
// layout a given repo uses.
function findProjectFile(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, '.local', 'project.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// Which profile governs `startDir` - the name from the nearest ancestor's project.json, or
// "default" if none exists anywhere above it. This is independent of app config resolution
// (CONFIG_PATH is always just cwd's own .local/config.json) - only the profile/cluster scope
// walks up.
function resolveProfileName(startDir = process.cwd()) {
  const file = findProjectFile(startDir);
  if (!file) return 'default';
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.profile) throw new Error(`${file} is missing a "profile" field.`);
  return raw.profile;
}

module.exports = { findProjectFile, resolveProfileName };
