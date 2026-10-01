#Requires -Version 5.1
# One-time installer stub. Everything past "install the CLI" (container engine detection, tool
# installs, cluster, TLS, hosts) lives in `localctl setup` (cli/src/commands/setup.js) -
# this script only does the bit that has to happen in a shell, because `localctl` doesn't exist
# yet: get Node running, install the CLI's own deps, and put a shim for it on your PATH.
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Log($msg)  { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (Test-Command node) {
  Ok "node already installed"
} elseif (Test-Command winget) {
  Log "Installing node via winget..."
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  Warn "Restart this PowerShell window and re-run this script so PATH picks up the new node install."
  exit 0
} else {
  Die "Node.js is required. Install it (https://nodejs.org) or winget, then re-run."
}

Log "Installing localctl CLI dependencies..."
Push-Location (Join-Path $RepoRoot "cli")
npm install --silent
Pop-Location

# Not `npm link`: it needs write access to npm's global prefix, which isn't guaranteed depending
# on how Node was installed. A self-contained shim avoids that and needs no elevation.
$LocalctlBinDir = Join-Path $env:USERPROFILE ".localctl\bin"
New-Item -ItemType Directory -Force -Path $LocalctlBinDir | Out-Null
$CliEntry = Join-Path $RepoRoot "cli\bin\localctl.js"
@"
@echo off
node "$CliEntry" %*
"@ | Set-Content -Path (Join-Path $LocalctlBinDir "localctl.cmd") -Encoding ASCII

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$LocalctlBinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$LocalctlBinDir", "User")
  Warn "localctl installed. Added it to your User PATH - open a new PowerShell window to use it."
} else {
  Ok "localctl installed (already on PATH)"
}

Write-Host ""
Log "Handing off to 'localctl setup' for the rest (container engine, cluster, TLS, hosts)..."
node $CliEntry setup
