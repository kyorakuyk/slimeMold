$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'readability-metrics-json-output.ps1')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$base = Join-Path $env:TEMP ("r7-json-handle-race-" + [guid]::NewGuid().ToString('N'))
$outputDir = Join-Path $base 'output'
$backupDir = Join-Path $base 'output-backup'
$repoAlias = Join-Path $base 'repo-alias'
$basename = ".r7-json-handle-race-$PID.tmp"
$target = Join-Path $root $basename
$sentinel = Join-Path $root ($basename + '.sentinel')
$output = Join-Path $outputDir $basename
$script:parentRestored = $false
if (Test-Path -LiteralPath $target) { throw "test target already exists: $target" }
if (Test-Path -LiteralPath $sentinel) { throw "test sentinel already exists: $sentinel" }

try {
  [IO.File]::WriteAllText($sentinel, 'preserve-me')
  [IO.Directory]::CreateDirectory($outputDir) | Out-Null
  New-Item -ItemType Junction -Path $repoAlias -Target $root | Out-Null
  Move-Item -LiteralPath $outputDir -Destination $backupDir
  Move-Item -LiteralPath $repoAlias -Destination $outputDir

  $afterOpen = {
    & $env:ComSpec /c rmdir "$outputDir"
    if ($LASTEXITCODE -ne 0) { throw "could not restore parent junction: $LASTEXITCODE" }
    Move-Item -LiteralPath $backupDir -Destination $outputDir
    $script:parentRestored = $true
  }

  $caughtExpectedRejection = $false
  try {
    Write-R7SafeJsonOutput -OutputPath $output -RepositoryRoot $root -JsonText '{"test":true}' -AfterOpen $afterOpen
  } catch {
    if ($_.Exception.Message -match 'inside the repository') { $caughtExpectedRejection = $true }
    else { throw }
  }

  if (-not $script:parentRestored) { throw 'race hook did not restore the parent before handle path validation' }
  if (-not $caughtExpectedRejection) { throw 'writer did not reject the repo-targeting handle' }
  if (Test-Path -LiteralPath $target) { throw 'handle-bound cleanup left a repository entry' }
  if ([IO.File]::ReadAllText($sentinel) -ne 'preserve-me') { throw 'repo sentinel changed' }
  [Console]::Out.WriteLine('PASS: parent restored before final-path lookup; repo entry removed by handle')
} finally {
  if (Test-Path -LiteralPath $outputDir) {
    try { & $env:ComSpec /c rmdir "$outputDir"; Move-Item -LiteralPath $backupDir -Destination $outputDir } catch {}
  }
  if (Test-Path -LiteralPath $backupDir) { try { Move-Item -LiteralPath $backupDir -Destination $outputDir } catch {} }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
  if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
}
