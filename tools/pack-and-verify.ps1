# pack-and-verify.ps1 - P9 一条龙（后台运行，可扛过应用重启导致的 MCP 断连）
# 流程：0.1.0 目录基线 -> 停应用 -> build-v2（dist-portable）-> 启 v2 产物 -> verify.ps1 五项
#       -> 停 v2 -> 重启 0.1.0 -> 0.1.0 目录基线复核 -> 写 docs\verify-p9.md 与 p9-done.txt
$ErrorActionPreference = 'Continue'
function Log($m) {
  $line = ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
  Add-Content -Path (Join-Path $PSScriptRoot '..\p9-progress.txt') -Value $line -Encoding UTF8
}
$root    = Split-Path -Parent $PSScriptRoot
$old     = 'C:\Users\Administrator\Desktop\本地AI遥控台-0.1.0-win-x64-便携版'
$out     = Join-Path $root 'dist-portable'
$exeNew  = Join-Path $out '六本豆mcp-v2.exe'
$oldExe  = Join-Path $old '六本豆mcp.exe'
$report  = Join-Path $root 'docs\verify-p9.md'
$done    = Join-Path $root 'p9-done.txt'

function Baseline($dir) {
  Get-ChildItem $dir -Recurse -File | ForEach-Object {
    "{0}|{1}|{2:o}" -f $_.FullName.Substring($dir.Length), $_.Length, $_.LastWriteTimeUtc
  } | Sort-Object
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Log 'P9 start'

try {
  $before = Baseline $old
  $before | Set-Content -Path (Join-Path $root 'p9-baseline-before.txt') -Encoding UTF8
  Log ('baseline before: ' + $before.Count + ' files')

  Log 'stop app'
  Stop-Process -Name '六本豆mcp' -Force -ErrorAction SilentlyContinue
  Stop-Process -Name '六本豆mcp-v2' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  Log 'build-v2'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-v2.ps1') -NoRestart -NoStop
  if ($LASTEXITCODE -ne 0) { throw "build-v2 exit $LASTEXITCODE" }
  Log 'build-v2 done'

  Log 'start v2 exe'
  Start-Process -FilePath $exeNew -WorkingDirectory $out
  $ok = $false
  for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
  }
  if (-not $ok) { throw 'v2 exe 20s 后端口未监听' }
  Log ('v2 exe up after ' + [math]::Round($i * 0.5, 1) + 's')
  Start-Sleep -Seconds 2

  Log 'verify.ps1'
  $verifyOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify.ps1') 2>&1 | Out-String
  $verifyCode = $LASTEXITCODE
  Log ('verify exit=' + $verifyCode)

  Log 'stop v2, restart 0.1.0'
  Stop-Process -Name '六本豆mcp-v2' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process -FilePath $oldExe -WorkingDirectory $old
  $ok2 = $false
  for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { $ok2 = $true; break }
  }
  Log ('0.1.0 back=' + $ok2)

  $after = Baseline $old
  $after | Set-Content -Path (Join-Path $root 'p9-baseline-after.txt') -Encoding UTF8
  $diff = Compare-Object $before $after
  $unchanged = ($null -eq $diff)
  Log ('baseline unchanged=' + $unchanged)

  $md = @()
  $md += '# P9 verify.ps1 结果存档'
  $md += ''
  $md += ('- 时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  $md += '- 产物：`v2\dist-portable\`（exe：`六本豆mcp-v2.exe`，asar：`resources\app.asar` 由 v2\src 打包）'
  $md += '- 运行时来源：0.1.0 便携版目录（只读复制）'
  $md += ''
  $md += '## verify.ps1 五项检查（针对 dist-portable 的六本豆mcp-v2.exe 实例）'
  $md += ''
  $md += '```'
  $md += $verifyOut.Trim()
  $md += '```'
  $md += ''
  $md += ('verify 退出码：' + $verifyCode)
  $md += ''
  $md += '## 0.1.0 便携版目录未改动核验'
  $md += ''
  $md += ('- 文件数：' + $before.Count + ' → ' + $after.Count)
  $md += ('- 名称/大小/修改时间全量比对：' + $(if ($unchanged) { '**完全一致（未被改动）**' } else { '**存在差异**（见下）' }))
  if (-not $unchanged) {
    $md += ''
    $md += '```'
    $md += ($diff | Out-String).Trim()
    $md += '```'
  }
  $md += ''
  $md += '## 核验说明'
  $md += ''
  $md += '- 打包前后均执行 `Stop-Process -Name 六本豆mcp -Force`（窗口 × 只会缩托盘，必须真退出否则 asar 被锁）。'
  $md += '- verify 期间运行的是 dist-portable 里的六本豆mcp-v2.exe；验证完已停止并恢复 0.1.0 应用。'
  $md += '- 基线明细见 `p9-baseline-before.txt` / `p9-baseline-after.txt`。'
  $md -join "`n" | Set-Content -Path $report -Encoding UTF8

  $status = if ($verifyCode -eq 0 -and $unchanged) { 'OK' } else { "PARTIAL verify=$verifyCode unchanged=$unchanged" }
  Set-Content -Path $done -Value $status -Encoding UTF8
  Log ('done: ' + $status)
} catch {
  Log ('ERROR: ' + $_.Exception.Message)
  Set-Content -Path $done -Value ('ERROR ' + $_.Exception.Message) -Encoding UTF8
  # 尽力恢复 0.1.0
  Stop-Process -Name '六本豆mcp-v2' -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $oldExe -WorkingDirectory $old -ErrorAction SilentlyContinue
}
