# dev.ps1 - one-click cleanup of leftover processes then start tauri dev
#
# Usage (from repo root in PowerShell):
#   .\scripts\dev.ps1
#
# Steps:
#   1. Free the occupied Vite port (default 1420, override with -Port)
#   2. Kill leftover slime-mold.exe / cargo(tauri) / node(vite) on that port
#   3. Launch `npx tauri dev` in background; logs -> tauri-dev.log / tauri-dev.err
#
# This script only touches this project's leftover processes.

param(
  [int]$Port = 1420,
  [string]$LogName = 'tauri-dev'
)

$ErrorActionPreference = 'SilentlyContinue'

function Kill-IfExists {
  param([int]$Id, [string]$Label)
  if ($Id -and $Id -gt 0) {
    try { Stop-Process -Id $Id -Force -ErrorAction Stop; Write-Host "  killed $Label (pid $Id)" }
    catch { Write-Host "  (skip $Label pid $Id : $_)" }
  }
}

Write-Host "==> [1/3] Free port $Port"
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

Write-Host '==> [2/3] Kill leftover slime-mold / cargo(tauri)'
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

Write-Host '==> [3/3] Start tauri dev'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$logOut = Join-Path $root.Path "$LogName.log"
$logErr = Join-Path $root.Path "$LogName.err"
Start-Process -FilePath 'npx.cmd' -ArgumentList 'tauri', 'dev' `
  -WorkingDirectory $root.Path `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
  -WindowStyle Hidden
Write-Host "  launched. tail logs: Get-Content $logOut -Tail 20 -Encoding utf8"
