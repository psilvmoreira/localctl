# Delegates the real teardown to `localctl uninstall` (cli/src/commands/uninstall.js), then
# finishes the one thing a running CLI can't safely do to itself: remove its own PATH entry.
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }

$CliNodeModules = Join-Path $RepoRoot "cli\node_modules"
if (Test-Path $CliNodeModules) {
  node (Join-Path $RepoRoot "cli\bin\localctl.js") uninstall @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Warn "cli\node_modules is missing, so the full 'localctl uninstall' can't run. Falling back to"
  Warn "a best-effort cluster/container-only cleanup (hosts file and Podman VM config are skipped -"
  Warn "check those by hand if you bootstrapped with Podman)."
  # Every project's cluster is named local-dev (the default project) or local-dev-<name> (any
  # Main project made with `localctl profiles new`) - match by prefix instead of the single
  # hardcoded default name, so this fallback doesn't orphan a non-default project's cluster.
  if (Get-Command k3d -ErrorAction SilentlyContinue) {
    (k3d cluster list --no-headers 2>$null) -split "`n" | ForEach-Object {
      $ClusterName = ($_ -split '\s+')[0]
      if ($ClusterName -like "local-dev*") { k3d cluster delete $ClusterName 2>&1 | Out-Null }
    }
  }
  $Engine = $null
  if (Get-Command docker -ErrorAction SilentlyContinue) { $Engine = "docker" }
  elseif (Get-Command podman -ErrorAction SilentlyContinue) { $Engine = "podman" }
  if ($Engine) {
    (& $Engine ps -a --format "{{.Names}}" 2>$null) -split "`n" | ForEach-Object {
      if ($_ -like "local-dev*-registry" -or $_ -eq "local-dev-registry") { & $Engine rm -f -v $_ 2>&1 | Out-Null }
    }
  }
}

$LocalctlBinDir = Join-Path $env:USERPROFILE ".localctl\bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -and $UserPath -like "*$LocalctlBinDir*") {
  $NewPath = ($UserPath -split ";" | Where-Object { $_ -ne $LocalctlBinDir }) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  Ok "Removed localctl from your User PATH"
}

$LocalctlStateDir = Join-Path $env:USERPROFILE ".localctl"
if (Test-Path $LocalctlStateDir) {
  Remove-Item -Recurse -Force $LocalctlStateDir
  Ok "Removed $LocalctlStateDir"
}

Write-Host ""
Ok "Uninstall complete."
Write-Host ""
Write-Host "Left in place (remove yourself if you want them gone too):"
Write-Host "  winget uninstall k3d-io.k3d Kubernetes.kubectl Tilt.dev.tilt FiloSottile.mkcert OpenJS.NodeJS.LTS"
Write-Host "  mkcert -uninstall   # removes the root CA from trust stores - affects EVERY"
Write-Host "                      # mkcert-issued cert on this machine, not just *.local.test"
