# Uninstalling

```
localctl uninstall     # cluster, registry, Podman VM config, hosts entries, certs/state
```

or, to also remove the CLI itself — pick whichever matches how you installed it:

```
npm uninstall -g @localctl/cli    # if you installed via `npm install -g .`
./bin/uninstall.sh                     # if you installed via bin/bootstrap.sh's PATH shim (macOS)
./bin/uninstall.ps1                    # same, Windows
```

All the teardown logic lives in `localctl uninstall` itself (`cli/src/commands/uninstall.js`) —
you can run it directly like any other `localctl` command; it works the same regardless of which
way you installed the CLI. The one thing it can't do is remove the CLI itself while it's the
process currently running, so that's a separate step matching your install method. Use
`localctl uninstall` alone for a reset you plan to `localctl setup` right back from; add the
CLI-removal step when you're done with this setup entirely.

**Exception**: `bin/uninstall.sh`/`.ps1`'s fallback path, used only if `cli/node_modules` is
missing (so the real `localctl uninstall` can't even run) - it does a best-effort cleanup of every
`local-dev*` cluster and registry container it can find by name, but skips the hosts file and
Podman VM config entirely (the script warns about this when it happens). It's meant to unstick a
broken install, not as a routine alternative to the real command - if `cli/node_modules` exists,
you're always getting the full teardown above.

All variants prompt for confirmation (skip with `-y`/`--yes`) and remove:

- **Every project's** k3d cluster (`local-dev` for `default`, `local-dev-<name>` for any Main
  project created with `localctl profiles new`) — **this deletes every app and database deployed
  in all of them**
- Their local image registry containers
- The insecure-registry config written into the Podman VM (Podman only, if present)
- The `*.local.test` block in your hosts file
- Any background dev loop `localctl app up` left running (stopped before its state is deleted)
- `~/.localctl` (certs, app registry state, the project registry `profiles.json`, dev-loop
  tracking — plus the PATH shim, `bin/uninstall.sh`/`.ps1` only)

Every step is best-effort and safe to re-run — if something was already removed, it's skipped
rather than erroring.

## What it deliberately leaves alone

- **k3d, kubectl, tilt, mkcert, helm, node themselves.** These are general-purpose dev tools
  `localctl setup` installed via Homebrew/winget; other projects on your machine may depend on
  them. Remove them yourself if you're sure nothing else needs them:
  ```
  brew uninstall k3d kubectl tilt mkcert helm node     # macOS
  winget uninstall k3d.k3d Kubernetes.kubectl FiloSottile.mkcert Helm.Helm OpenJS.NodeJS.LTS  # Windows
  ```
  Tilt isn't on winget: on Windows `localctl setup` downloads it from its GitHub release into
  `~.localctl	ools` and adds that folder to your user PATH. Delete the folder to remove it.
- **mkcert's root CA trust.** `mkcert` uses a single CA for every certificate it issues on your
  machine, not one per project. Uninstalling it (`mkcert -uninstall`) would also untrust any other
  local-dev certs you've generated with mkcert elsewhere. The script tells you the command at the
  end; run it yourself only if you're sure that's what you want.

## What it does NOT touch

- This repo itself (`localctl/`) — delete the directory yourself if you're done with it
  entirely.
- `cli/node_modules` — harmless to leave, or `rm -rf cli/node_modules` if you want it gone too.
- Any app repos' own `.local/` folders — those belong to the app repos, not this one.
