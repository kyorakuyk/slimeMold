# dev.ps1 - one-click cleanup of leftover processes then start tauri dev
#
# Usage (from repo root in PowerShell):
#   .\scripts\dev.ps1                # quick start (no build)
#   .\scripts\dev.ps1 -Build         # clean dist + npm run build + start
#   .\scripts\dev.ps1 -Build -Port 3000 -LogName my-dev
#
# Steps (with -Build):
#   1. Free the occupied Vite port (default 1420, override with -Port)
#   2. Kill leftover slime-mold.exe / cargo(tauri) / node(vite) on that port
#   3. [Build] Remove dist, then npm run build (tsc -b + vite build)
#   4. Launch `npx tauri dev` in background; logs -> <LogName>.log / <LogName>.err
#
# This script only touches this project's leftover processes.
# Note: `npx tauri dev` starts Vite itself (beforeDevCommand), so a pre-build is
# optional; pass -Build only when you want a clean rebuild before launching.

param(
  [int]$Port = 1420,
  [string]$LogName = 'tauri-dev',
  [switch]$Build
)

$ErrorActionPreference = 'SilentlyContinue'

# 项目根（本脚本位于 <root>/scripts/dev.ps1）——构建与启动共用，需在步骤 1 前解析
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

function Kill-IfExists {
  param([int]$Id, [string]$Label)
  if ($Id -and $Id -gt 0) {
    try { Stop-Process -Id $Id -Force -ErrorAction Stop; Write-Host "  killed $Label (pid $Id)" }
    catch { Write-Host "  (skip $Label pid $Id : $_)" }
  }
}

Write-Host "==> [1/4] Free port $Port"
$portPids = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess |
  Sort-Object -Unique
if ($portPids) {
  foreach ($pid_ in $portPids) {
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    Write-Host "  port occupied by pid=$pid_ name=$($proc.Name)"
    Kill-IfExists $pid_ 'port-occupant'
  }
} else {
  Write-Host '  port is free'
}

Write-Host '==> [2/4] Kill leftover slime-mold / cargo(tauri)'
Get-CimInstance Win32_Process -Filter "Name='slime-mold.exe'" |
  ForEach-Object { Kill-IfExists $_.ProcessId 'slime-mold' }

Get-CimInstance Win32_Process -Filter "Name='cargo.exe'" |
  Where-Object { $_.CommandLine -like '*tauri*' } |
  ForEach-Object { Kill-IfExists $_.ProcessId 'cargo(tauri)' }

Start-Sleep -Seconds 1
$stillPids = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess |
  Sort-Object -Unique
if ($stillPids) {
  Write-Host '  port still occupied, force-kill related node processes'
  foreach ($pid_ in $stillPids) { Kill-IfExists $pid_ 'port-occupant-retry' }
}

Write-Host '==> [3/4] Clean dist + npm run build (only with -Build)'
if ($Build) {
  $dist = Join-Path $root.Path 'dist'
  if (Test-Path -LiteralPath $dist) {
    Remove-Item -LiteralPath $dist -Recurse -Force
    Write-Host '  removed dist/'
  } else {
    Write-Host '  dist/ not present, skip'
  }
  Write-Host '  running: npm run build'
  Push-Location $root.Path
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  BUILD FAILED, abort before launching' -ForegroundColor Red
      exit $LASTEXITCODE
    }
    Write-Host '  build ok'
  } finally {
    Pop-Location
  }
} else {
  Write-Host '  skipped (pass -Build to clean+rebuild first)'
}

Write-Host '==> [4/4] Start tauri dev'
$logOut = Join-Path $root.Path "$LogName.log"
$logErr = Join-Path $root.Path "$LogName.err"
Start-Process -FilePath 'npx.cmd' -ArgumentList 'tauri', 'dev' `
  -WorkingDirectory $root.Path `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
  -WindowStyle Hidden
Write-Host "  launched. tail logs: Get-Content $logOut -Tail 20 -Encoding utf8"
