#!/usr/bin/env bash
# One-time installer stub. Everything past "install the CLI" (container engine detection, tool
# installs, cluster, TLS, hosts) lives in `localctl setup` (cli/src/commands/setup.js) -
# this script only does the bit that has to happen in a shell, because `localctl` doesn't exist
# yet: get Node running, install the CLI's own deps, and put a shim for it on your PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { echo -e "\033[36m[info]\033[0m $1"; }
ok()   { echo -e "\033[32m[ok]\033[0m $1"; }
warn() { echo -e "\033[33m[warn]\033[0m $1"; }
die()  { echo -e "\033[31m[error]\033[0m $1"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

if command_exists node; then
  ok "node already installed"
elif command_exists brew; then
  log "Installing node via brew..."
  brew install node
elif [ "$(uname -s)" = "Linux" ]; then
  # No sudo from a script: print the right command for this distro and let the user run it.
  NODE_HINT="your package manager's nodejs package, or https://nodejs.org"
  if command_exists apt-get; then NODE_HINT="sudo apt install nodejs npm"
  elif command_exists dnf; then NODE_HINT="sudo dnf install nodejs npm"
  elif command_exists pacman; then NODE_HINT="sudo pacman -S nodejs npm"
  elif command_exists zypper; then NODE_HINT="sudo zypper install nodejs npm"
  elif command_exists apk; then NODE_HINT="sudo apk add nodejs npm"
  fi
  die "Node.js 18+ is required. Install it with: $NODE_HINT (distro packages can be old - https://nodejs.org or nvm always work), then re-run."
else
  die "Node.js is required. Install it (https://nodejs.org) or Homebrew (https://brew.sh), then re-run."
fi

log "Installing localctl CLI dependencies..."
(cd "$REPO_ROOT/cli" && npm install --silent)

# Not `npm link`: it needs write access to npm's global prefix (e.g. /usr/local/lib/node_modules),
# which isn't guaranteed depending on how Node was installed, and fails with EACCES on plenty of
# setups. A self-contained shim avoids sudo entirely and works the same regardless of Node's origin.
LOCALCTL_BIN_DIR="$HOME/.localctl/bin"
mkdir -p "$LOCALCTL_BIN_DIR"
cat > "$LOCALCTL_BIN_DIR/localctl" <<EOF
#!/usr/bin/env bash
exec node "$REPO_ROOT/cli/bin/localctl.js" "\$@"
EOF
chmod +x "$LOCALCTL_BIN_DIR/localctl"

SHELL_RC=""
case "${SHELL:-}" in
  */zsh) SHELL_RC="$HOME/.zshrc" ;;
  # macOS terminals start login shells (.bash_profile); Linux terminals start interactive
  # non-login ones, which only read .bashrc.
  */bash)
    if [ "$(uname -s)" = "Linux" ]; then SHELL_RC="$HOME/.bashrc"; else SHELL_RC="$HOME/.bash_profile"; fi
    ;;
esac

case ":$PATH:" in
  *":$LOCALCTL_BIN_DIR:"*)
    ok "localctl installed (already on PATH)"
    ;;
  *)
    if [ -n "$SHELL_RC" ] && ! grep -qF "$LOCALCTL_BIN_DIR" "$SHELL_RC" 2>/dev/null; then
      { echo ''; echo '# Added by localctl bootstrap'; echo "export PATH=\"$LOCALCTL_BIN_DIR:\$PATH\""; } >> "$SHELL_RC"
      warn "localctl installed. Added it to PATH in $SHELL_RC - run 'source $SHELL_RC' or open a new terminal."
    else
      warn "localctl installed at $LOCALCTL_BIN_DIR/localctl but that's not on your PATH yet."
      warn "Add this to your shell profile: export PATH=\"$LOCALCTL_BIN_DIR:\$PATH\""
    fi
    ;;
esac

echo
log "Handing off to 'localctl setup' for the rest (container engine, cluster, TLS, hosts)..."
exec node "$REPO_ROOT/cli/bin/localctl.js" setup
