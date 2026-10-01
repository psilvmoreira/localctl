#!/usr/bin/env bash
# Delegates the real teardown to `localctl uninstall` (cli/src/commands/uninstall.js), then
# finishes the one thing a running CLI can't safely do to itself: delete its own shim/PATH line.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok()   { echo -e "\033[32m[ok]\033[0m $1"; }
warn() { echo -e "\033[33m[warn]\033[0m $1"; }

if [ -d "$REPO_ROOT/cli/node_modules" ]; then
  node "$REPO_ROOT/cli/bin/localctl.js" uninstall "$@"
  STATUS=$?
  [ $STATUS -eq 0 ] || exit $STATUS
else
  warn "cli/node_modules is missing, so the full 'localctl uninstall' can't run. Falling back to"
  warn "a best-effort cluster/container-only cleanup (hosts file and Podman VM config are skipped -"
  warn "check those by hand if you bootstrapped with Podman)."
  # Every project's cluster is named local-dev (the default project) or local-dev-<name> (any
  # Main project made with `localctl profiles new`) - loop by prefix instead of the single
  # hardcoded default name, so this fallback doesn't orphan a non-default project's cluster.
  if command -v k3d >/dev/null 2>&1; then
    k3d cluster list -o json 2>/dev/null | grep -o '"name":"local-dev[^"]*"' | cut -d'"' -f4 | while read -r CLUSTER; do
      k3d cluster delete "$CLUSTER" 2>&1 | grep -v '^$' || true
    done
  fi
  ENGINE=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then ENGINE=podman
  fi
  if [ -n "$ENGINE" ]; then
    "$ENGINE" ps -a --format '{{.Names}}' 2>/dev/null | grep '^local-dev.*-registry$' | while read -r REGISTRY; do
      "$ENGINE" rm -f -v "$REGISTRY" >/dev/null 2>&1 || true
    done
  fi
fi

# The CLI process that just ran can't delete the shim it's executing from - finish that here,
# now that it has already exited.
for RC in "$HOME/.zshrc" "$HOME/.bash_profile"; do
  if [ -f "$RC" ] && grep -qE "# Added by (localctl|Project-Infra) bootstrap" "$RC"; then
    TMP="$(mktemp)"
    awk '
      /^# Added by (localctl|Project-Infra) bootstrap$/ { skip=1; next }
      skip > 0 { skip--; next }
      { print }
    ' "$RC" > "$TMP"
    mv "$TMP" "$RC"
    ok "Cleaned $RC"
  fi
done

if [ -d "$HOME/.localctl" ]; then
  rm -rf "$HOME/.localctl"
  ok "Removed ~/.localctl (CLI shim + remaining state)"
fi

echo
ok "Uninstall complete."
echo
echo "Left in place (remove yourself if you want them gone too):"
echo "  brew uninstall k3d kubectl tilt mkcert node   # only if nothing else needs them"
echo "  mkcert -uninstall   # removes the root CA from trust stores - affects EVERY mkcert-issued"
echo "                      # cert on this machine, not just *.local.test"
