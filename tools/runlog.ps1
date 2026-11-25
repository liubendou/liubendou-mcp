# runlog.ps1 - P4 run log helper (dot-source then use)
#   . tools\runlog.ps1
#   Start-RunLog -Task T15
#   Add-RunLog "what was done"
#   Complete-RunLog -Summary "one line" -Attach "C:\path\file"
$script:RunLogTask = $null
$script:RunLogDir = Join-Path $env:USERPROFILE 'ops-tmp'

function Start-RunLog {
  param([Parameter(Mandatory=$true)][string]$Task)
  $script:RunLogTask = $Task
  New-Item -ItemType Directory -Force -Path $script:RunLogDir | Out-Null
  $p = Join-Path $script:RunLogDir ($Task + '-progress.txt')
  Set-Content -Path $p -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] START ' + $Task) -Encoding UTF8
  Write-Output ('RUNLOG-START ' + $p)
}

function Add-RunLog {
  param([Parameter(Mandatory=$true)][string]$Text)
  if (-not $script:RunLogTask) { throw 'call Start-RunLog first' }
  $p = Join-Path $script:RunLogDir ($script:RunLogTask + '-progress.txt')
  Add-Content -Path $p -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Text) -Encoding UTF8
}

function Complete-RunLog {
  param([string]$Summary = '', [string[]]$Attach = @())
  if (-not $script:RunLogTask) { throw 'call Start-RunLog first' }
  $v2 = (Get-ChildItem (Join-Path $env:USERPROFILE 'Desktop') | Where-Object { $_.PSIsContainer -and $_.Name -like '*-v2' } | Select-Object -First 1).FullName
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  $dest = Join-Path $v2 ('docs\runs\' + $script:RunLogTask + '-' + $stamp)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $prog = Join-Path $script:RunLogDir ($script:RunLogTask + '-progress.txt')
  if (Test-Path $prog) { Move-Item $prog (Join-Path $dest 'progress.txt') -Force }
  if ($Summary) { Set-Content -Path (Join-Path $dest 'summary.md') -Value $Summary -Encoding UTF8 }
  foreach ($f in $Attach) { if (Test-Path $f) { Copy-Item $f $dest -Force } }
  $done = Join-Path $script:RunLogDir ($script:RunLogTask + '-done.txt')
  Set-Content -Path $done -Value ('OK archived -> ' + $dest) -Encoding UTF8
  Move-Item $done (Join-Path $dest 'done.txt') -Force
  Write-Output ('RUNLOG-ARCHIVED ' + $dest)
}
