#!/usr/bin/env bash
# Runs INSIDE a throwaway Linux container (started by distros.js). Everything here happens in a
# disposable root filesystem: it installs Node and Docker the way a user on this distro would,
# starts dockerd by hand (containers have no systemd), then runs setup, doctor and the e2e suite.
# Every stage's exit code goes to /out/summary.json so the host can build the matrix.
set +e
export HOME=/root DEBIAN_FRONTEND=noninteractive
OUT=/out; mkdir -p "$OUT/logs"
CLI=/repo/cli/bin/localctl.js
declare -A RC

# Per-stage time limits (seconds): a stage that hangs must fail with a diagnosis, not hold the
# whole run until the outer timeout.
declare -A LIMIT=([prereqs]=600 [node]=300 [install-docker]=600 [dockerd]=120 [setup]=900 [doctor]=120 [e2e]=2400)

diagnose() { # what the nested engine looked like when a stage failed or timed out
  {
    echo "### docker ps -a"; docker ps -a --format '{{.Names}}  {{.Status}}' 2>&1
    for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^k3d-'); do
      echo; echo "### docker logs $c (last 40)"; docker logs --tail 40 "$c" 2>&1
    done
    echo; echo "### dockerd.log (last 30)"; tail -30 /var/log/dockerd.log 2>&1
    echo; echo "### memory"; free -m 2>&1; echo; echo "### iptables backend"; iptables --version 2>&1
  } > "$OUT/logs/diagnostics-$1.log" 2>&1
}

stage() { # stage <name> <cmd...> : runs it with a time limit, logs it, records the exit code
  local name=$1; shift
  echo "=== [$name] $*"
  echo "running" > "$OUT/logs/$name.rc"
  # `timeout` can only run programs, so a shell function is run through a child bash (exported).
  if declare -F "$1" >/dev/null; then
    timeout --kill-after=15 "${LIMIT[$name]:-600}" bash -c "$1" > "$OUT/logs/$name.log" 2>&1
  else
    timeout --kill-after=15 "${LIMIT[$name]:-600}" "$@" > "$OUT/logs/$name.log" 2>&1
  fi
  RC[$name]=$?
  # Written right away (not only in summary.json at the end): if the container is killed midway,
  # the host still knows which stages finished and how.
  echo "${RC[$name]}" > "$OUT/logs/$name.rc"
  if [ "${RC[$name]}" -eq 124 ] || [ "${RC[$name]}" -eq 137 ]; then
    echo "    -> TIMED OUT after ${LIMIT[$name]:-600}s"
  else
    echo "    -> exit ${RC[$name]}"
  fi
  if [ "${RC[$name]}" -ne 0 ]; then
    tail -8 "$OUT/logs/$name.log" | sed 's/^/    | /'
    [ "$name" != install-docker ] && diagnose "$name"
  fi
  return 0
}

. /etc/os-release 2>/dev/null || . /usr/lib/os-release
echo "distro: $PRETTY_NAME ($(uname -m))"
ARCH=$(uname -m); case "$ARCH" in x86_64) NODE_ARCH=x64;; aarch64) NODE_ARCH=arm64;; *) NODE_ARCH=$ARCH;; esac

install_prereqs() {
  if command -v apt-get >/dev/null; then
    apt-get update -qq && apt-get install -y -qq curl ca-certificates tar gzip iptables procps lsof
  elif command -v dnf >/dev/null; then
    dnf install -y -q tar gzip iptables-nft procps-ng lsof ca-certificates $(command -v curl >/dev/null || echo curl)
  elif command -v zypper >/dev/null; then
    zypper --non-interactive -q install curl tar gzip iptables procps lsof ca-certificates
  elif command -v pacman >/dev/null; then
    sed -i 's/^#\?DisableSandbox.*//' /etc/pacman.conf; grep -q DisableSandbox /etc/pacman.conf || sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf
    [ "$ID" = archarm ] || [ "$ID" = arch ] && [ ! -d /etc/pacman.d/gnupg/private-keys-v1.d ] && { pacman-key --init; pacman-key --populate archlinuxarm 2>/dev/null || pacman-key --populate archlinux; }
    pacman -Syu --noconfirm --needed curl tar gzip iptables-nft procps-ng lsof ca-certificates
  else
    echo "no supported package manager"; return 1
  fi
}

# Node: the distro's own package is too old on some releases (Ubuntu 22.04 ships Node 12), so use
# the official tarball, which is also what the docs recommend for old distros.
install_node() {
  local v
  v=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$NODE_ARCH.tar.gz" | head -1)
  [ -n "$v" ] || { echo "could not resolve a Node 22 tarball for $NODE_ARCH"; return 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$v" | tar -xz -C /usr/local --strip-components=1
  node --version
}

wait_docker() { for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

# cgroup v2 only lets a cgroup delegate controllers to children while it holds no processes
# itself. A container's root cgroup holds this shell, so dockerd (and k3s's kubelet under it) get
# "failed to enable controllers" and the nested cluster never comes up. Move everything into a
# leaf cgroup first, then delegate - the same thing the docker:dind image's entrypoint does.
fix_cgroup_v2() {
  [ -f /sys/fs/cgroup/cgroup.controllers ] || return 0
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
  echo "cgroup v2 controllers delegated: $(cat /sys/fs/cgroup/cgroup.subtree_control)"
}

start_dockerd() {
  fix_cgroup_v2
  (dockerd >/var/log/dockerd.log 2>&1 &)
  wait_docker || { tail -20 /var/log/dockerd.log; return 1; }
  docker info --format 'server={{.ServerVersion}} driver={{.Driver}} cgroup={{.CgroupVersion}} mem={{.MemTotal}}'
}

export -f install_prereqs install_node wait_docker start_dockerd fix_cgroup_v2
export ARCH NODE_ARCH ID OUT

stage prereqs install_prereqs
stage node install_node
cd /repo/cli || exit 1

# Docker through localctl's own flag: the same path a user on this distro would take. In a
# container there is no service manager, so it installs but cannot start the daemon: expected.
stage install-docker node "$CLI" setup --install-docker
stage dockerd start_dockerd
# /var/lib/docker is a cache volume kept between runs for the images. Containers left in it by an
# earlier (killed) run are not wanted: start from an empty engine, keeping only the images.
docker ps -aq | xargs -r docker rm -f -v >/dev/null 2>&1
docker network prune -f >/dev/null 2>&1

stage setup node "$CLI" setup
stage doctor node "$CLI" doctor

export LOCALCTL_E2E_REPORT_DIR="$OUT/e2e"
if [ "${RC[setup]}" -eq 0 ] || command -v k3d >/dev/null; then
  stage e2e node scripts/e2e/run.js --yes --restore-after $E2E_ARGS
else
  echo "=== [e2e] skipped: setup failed"; RC[e2e]=-1
fi

{
  echo "{"
  echo "  \"distro\": \"$PRETTY_NAME\", \"id\": \"$ID\", \"version\": \"$VERSION_ID\", \"arch\": \"$ARCH\","
  echo "  \"stages\": {"
  first=1; for k in prereqs node install-docker dockerd setup doctor e2e; do
    [ $first -eq 0 ] && echo ","; first=0
    printf '    "%s": %s' "$k" "${RC[$k]:--1}"
  done
  echo; echo "  }"; echo "}"
} > "$OUT/summary.json"
cat "$OUT/summary.json"
# Final container state to the host log, useful when something above went wrong.
docker ps -a --format '{{.Names}}  {{.Status}}' 2>/dev/null | head -10
exit 0
