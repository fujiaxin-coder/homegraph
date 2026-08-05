#Requires -Version 5.1
<#
.SYNOPSIS
  Run local homegraph index/init against a project while sampling the FULL
  process-tree WorkingSet (main node + liftoff re-exec + parse workers).

.DESCRIPTION
  Prints elapsed time + current tree RSS + peak tree RSS on an interval.
  At exit, prints a one-line peak summary. Memory = sum of WorkingSetSize
  for the launched process and all descendants (not V8 heap alone).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\homegraph\scripts\index-peak-mem.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\homegraph\scripts\index-peak-mem.ps1 `
    -Project D:\code\scene_board_ext -Command index -IntervalSec 3 -Build
#>
[CmdletBinding()]
param(
  [string]$Project = 'D:\code\scene_board_ext',
  [string]$HomeGraphRoot = 'D:\code\homegraph',
  # init = init -i (greenfield); index = re-index; sync = incremental
  [ValidateSet('init', 'index', 'sync')]
  [string]$Command = 'index',
  [int]$IntervalSec = 5,
  [switch]$Build,
  [switch]$VerboseProgress  # pass --verbose to homegraph
)

$ErrorActionPreference = 'Stop'

function Get-DescendantPids([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)
  $byParent = @{}
  foreach ($p in $all) {
    $pp = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.Generic.List[int] }
    [void]$byParent[$pp].Add([int]$p.ProcessId)
  }
  $out = New-Object System.Collections.Generic.List[int]
  $q = New-Object System.Collections.Generic.Queue[int]
  $q.Enqueue($RootPid)
  $seen = @{}
  while ($q.Count -gt 0) {
    $id = $q.Dequeue()
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    [void]$out.Add($id)
    if ($byParent.ContainsKey($id)) {
      foreach ($child in $byParent[$id]) { $q.Enqueue($child) }
    }
  }
  return $out
}

function Get-TreeRssBytes([int]$RootPid) {
  $pids = @(Get-DescendantPids $RootPid)
  if ($pids.Count -eq 0) { return 0L }
  $sum = 0L
  foreach ($id in $pids) {
    try {
      $proc = Get-Process -Id $id -ErrorAction Stop
      $sum += [int64]$proc.WorkingSet64
    } catch {
      # process exited between snapshot and query
    }
  }
  return $sum
}

if (-not (Test-Path -LiteralPath $Project)) {
  throw "Project path not found: $Project"
}
if (-not (Test-Path -LiteralPath (Join-Path $HomeGraphRoot 'dist\bin\homegraph.js'))) {
  throw "homegraph binary missing — run npm run build in $HomeGraphRoot first (or pass -Build)"
}

Set-Location -LiteralPath $HomeGraphRoot

if ($Build) {
  Write-Host "==> npm run build"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
}

$hgJs = Join-Path $HomeGraphRoot 'dist\bin\homegraph.js'
# path is positional: `homegraph index|init|sync <path>` (not --path)
$args = @($hgJs, $Command, $Project)
if ($VerboseProgress) { $args += '--verbose' }

Write-Host "==> node $($args -join ' ')"
Write-Host "==> sampling every ${IntervalSec}s — tree WorkingSet (RSS) of homegraph + descendants"
Write-Host ""

$proc = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList $args `
  -WorkingDirectory $HomeGraphRoot `
  -NoNewWindow -PassThru

$rootPid = [int]$proc.Id
$t0 = [datetime]::UtcNow
$peakBytes = 0L
$peakAt = $t0
$sampleN = 0

try {
  while (-not $proc.HasExited) {
    Start-Sleep -Seconds $IntervalSec
    try { $proc.Refresh() } catch { break }
    if ($proc.HasExited) { break }

    $rss = Get-TreeRssBytes $rootPid
    if ($rss -gt $peakBytes) {
      $peakBytes = $rss
      $peakAt = [datetime]::UtcNow
    }
    $sampleN++
    $elapsed = ([datetime]::UtcNow - $t0).TotalSeconds
    $pids = @(Get-DescendantPids $rootPid)
    Write-Host ("[{0:HH:mm:ss}] +{1,7:N1}s  RSS={2,8:N1} MB  peak={3,8:N1} MB  procs={4}" -f `
      (Get-Date), $elapsed, ($rss / 1MB), ($peakBytes / 1MB), $pids.Count)
  }
} finally {
  if (-not $proc.HasExited) {
    try { $proc.WaitForExit() } catch {}
  }
}

# Final sample (catch peak right before exit)
$rssFinal = Get-TreeRssBytes $rootPid
if ($rssFinal -gt $peakBytes) { $peakBytes = $rssFinal }

$totalSec = ([datetime]::UtcNow - $t0).TotalSeconds
$peakSec = ($peakAt - $t0).TotalSeconds
Write-Host ""
Write-Host "======== peak memory (process tree WorkingSet) ========"
Write-Host ("  project : {0}" -f $Project)
Write-Host ("  command : homegraph {0}" -f $Command)
Write-Host ("  exit    : {0}" -f $proc.ExitCode)
Write-Host ("  elapsed : {0:N1}s" -f $totalSec)
Write-Host ("  samples : {0}" -f $sampleN)
Write-Host ("  PEAK RSS: {0:N1} MB  (at +{1:N1}s)" -f ($peakBytes / 1MB), $peakSec)
Write-Host "======================================================="

exit $(if ($null -eq $proc.ExitCode) { 1 } else { $proc.ExitCode })
