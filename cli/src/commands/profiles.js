const fs = require('fs');
const path = require('path');
const { run, getFreePort } = require('../lib/exec');
const { provisionCluster, teardownCluster, clusterExists } = require('../lib/clusterProvision');
const { enableClusterAddon } = require('../lib/clusterAddons');
const {
  getProfile, upsertProfile, listProfiles, getActive, setActive, mainProjectFor, childrenOf,
} = require('../lib/profileStore');
const { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT, REGISTRY_HOST_PORT } = require('../lib/constants');
const { makePrompter } = require('../lib/prompt');
const ui = require('../lib/ui');
const logger = require('../lib/logger');

// Tears down every OTHER Main project's cluster that's currently up - used when switching to (or
// creating) an `exclusive` Main project, since two clusters bound to the same host :80/:443 can't
// run at once anyway.
function teardownOtherMains(exceptMainName) {
  Object.entries(listProfiles()).forEach(([name, def]) => {
    if (def.isolation === 'cluster' && name !== exceptMainName && clusterExists(def.cluster)) {
      logger.step(`Tearing down "${name}"'s cluster (exclusive project switch)...`);
      teardownCluster(def.cluster);
    }
  });
}

function bringUpMain(mainDef) {
  provisionCluster({
    clusterName: mainDef.cluster,
    httpPort: mainDef.httpPort || DEFAULT_HTTP_PORT,
    httpsPort: mainDef.httpsPort || DEFAULT_HTTPS_PORT,
    registryPort: mainDef.registryPort || REGISTRY_HOST_PORT,
  });
}

async function newProfile(name) {
  if (getProfile(name)) {
    logger.warn(`"${name}" is already registered - this will overwrite its definition (any cluster it already owns is left running as-is).`);
  }

  const { ask, close } = makePrompter();
  try {
    const kindAns = await ask('Own cluster (Main project), or share an existing project\'s cluster (namespace-scoped)? [cluster/namespace]', 'cluster');
    const namespaceScoped = kindAns.trim().toLowerCase().startsWith('n');

    if (namespaceScoped) {
      const mains = Object.entries(listProfiles()).filter(([, d]) => d.isolation === 'cluster').map(([n]) => n);
      const parent = await ask(`Parent Main project (${mains.join(', ')})`, getActive());
      const parentDef = getProfile(parent);
      if (!parentDef || parentDef.isolation !== 'cluster') {
        throw new Error(`"${parent}" isn't a registered Main project. Run "localctl profiles list".`);
      }
      const namespacePrefix = await ask('Namespace/subdomain prefix for this project\'s apps', name);
      upsertProfile(name, { isolation: 'namespace', parent, namespace: namespacePrefix });
      logger.success(`Registered "${name}", namespace-scoped under "${parent}" (apps get a "${namespacePrefix}-" prefix).`);

      if (!clusterExists(parentDef.cluster)) {
        logger.warn(`Parent project "${parent}"'s cluster isn't up yet - run "localctl profiles switch ${parent}" before deploying here.`);
      } else {
        run('kubectl', ['config', 'use-context', `k3d-${parentDef.cluster}`], { stdio: 'ignore' });
      }
    } else {
      const exclusiveAns = await ask('Tear down other Main projects\' clusters whenever you switch to this one? [Y/n]', 'y');
      const exclusive = !/^n(o)?$/i.test(exclusiveAns);
      const def = { isolation: 'cluster', cluster: `local-dev-${name}`, exclusive };
      if (!exclusive) {
        // Two clusters can't both bind host :80/:443 - a non-exclusive (concurrent-with-others)
        // Main project gets its own free ports instead, at the cost of URLs needing a :port suffix.
        def.httpPort = await getFreePort();
        def.httpsPort = await getFreePort();
        def.registryPort = await getFreePort();
        logger.info(`Assigned its own ports (won't collide with an exclusive project's :80/:443): http ${def.httpPort}, https ${def.httpsPort}, registry ${def.registryPort}.`);
      }
      upsertProfile(name, def);
      logger.success(`Registered Main project "${name}" (cluster "${def.cluster}").`);

      if (exclusive) teardownOtherMains(name);
      logger.step(`Bringing up "${name}"'s cluster...`);
      bringUpMain(def);

      const addonAns = await ask('Cluster-wide addons to enable here now, comma-separated (blank for none)', '');
      addonAns.split(',').map((s) => s.trim()).filter(Boolean).forEach((addonName) => {
        logger.step(`Enabling addon "${addonName}"...`);
        enableClusterAddon(addonName);
      });
    }

    setActive(name);

    const localDir = path.join(process.cwd(), '.local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'project.json'), `${JSON.stringify({ profile: name }, null, 2)}\n`);
    logger.success(`Wrote .local/project.json here - every app under ${process.cwd()} now belongs to "${name}" unless a subfolder overrides it.`);
  } finally {
    close();
  }
}

function switchProfile(name) {
  const target = getProfile(name);
  if (!target) {
    throw new Error(`Unknown profile "${name}". Run "localctl profiles list", or "localctl profiles new ${name}" to create it.`);
  }

  const { name: mainName, def: mainDef } = mainProjectFor(name);
  if (mainDef.exclusive) teardownOtherMains(mainName);

  if (!clusterExists(mainDef.cluster)) {
    logger.step(`Bringing up "${mainName}"'s cluster...`);
    bringUpMain(mainDef);
  } else {
    run('kubectl', ['config', 'use-context', `k3d-${mainDef.cluster}`], { stdio: 'ignore' });
  }

  setActive(name);
  logger.success(`Switched to "${name}"${name !== mainName ? ` (namespace-scoped under "${mainName}")` : ''}.`);
}

function listProfilesCmd() {
  const profiles = listProfiles();
  const active = getActive();

  Object.entries(profiles)
    .filter(([, def]) => def.isolation === 'cluster')
    .forEach(([name, def]) => {
      const up = clusterExists(def.cluster);
      const marker = name === active ? ui.ok('*') : ' ';
      const portsNote = def.exclusive ? '' : ` http:${def.httpPort} https:${def.httpsPort}`;
      console.log(
        `${marker} ${ui.bold(name)}  [cluster: ${def.cluster}, ${up ? ui.ok('up') : ui.dim('down')}, ` +
        `${def.exclusive ? 'exclusive' : 'concurrent'}${portsNote}]`,
      );
      childrenOf(name).forEach((child) => {
        const childMarker = child === active ? ui.ok('*') : ' ';
        const childDef = profiles[child];
        console.log(`  ${childMarker} ${child}  [namespace: ${childDef.namespace || child}-*]`);
      });
    });
}

function statusCmd() {
  const active = getActive();
  const def = getProfile(active);
  const { name: mainName, def: mainDef } = mainProjectFor(active);

  console.log(ui.bold(active));
  console.log(`  isolation: ${def.isolation}`);
  if (def.isolation === 'namespace') {
    console.log(`  parent:    ${def.parent}`);
    console.log(`  namespace: ${def.namespace || active}-*`);
  }
  console.log(`  cluster:   ${mainDef.cluster} (${clusterExists(mainDef.cluster) ? ui.ok('up') : ui.dim('down')})`);
  if (!mainDef.exclusive) {
    console.log(`  ports:     http ${mainDef.httpPort} / https ${mainDef.httpsPort} / registry ${mainDef.registryPort}`);
  }
  console.log(`  exclusive: ${mainDef.exclusive ? 'yes - switching away tears this cluster down' : 'no - can run alongside other projects'}`);
}

module.exports = (program) => {
  const profiles = program.command('profiles').description('Manage projects: isolated clusters or namespace-scoped slices of one');

  profiles
    .command('new <name>')
    .description('Create a project - its own cluster, or namespace-scoped under an existing one - and mark the current directory as belonging to it')
    .action(newProfile);

  profiles
    .command('list')
    .description('List every project this machine knows about, nested under its Main (cluster) project')
    .action(listProfilesCmd);

  profiles
    .command('switch <name>')
    .description('Switch the active project - brings its cluster up if needed, applies its exclusive-teardown setting')
    .action(switchProfile);

  profiles
    .command('status')
    .description('Show the currently active project')
    .action(statusCmd);
};
