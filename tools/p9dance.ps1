# p9dance.ps1 - P9 验证独舞（经计划任务运行，独立于应用进程，可扛过 Stop-Process）
# 停 0.1.0 -> 起 v2 产物 -> verify.ps1 五项 -> 停 v2 -> 恢复 0.1.0 -> 基线比对 -> 存档
# 输出全部写 ASCII 路径 C:\Users\Administrator\p9-*，最后拷回 v2。
$ErrorActionPreference = 'Continue'
$prog = 'C:\Users\Administrator\p9-progress.txt'
$done = 'C:\Users\Administrator\p9-done.txt'
function Log($m) {
  Add-Content -Path $prog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8
}
function KillTunnel {
  Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*-R*8765*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function WaitPort($sec) {
  for ($i = 1; $i -le ($sec * 2); $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { return $true }
  }
  return $false
}
function Baseline($dir) {
  Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    "{0}|{1}|{2:o}" -f $_.FullName.Substring($dir.Length), $_.Length, $_.LastWriteTimeUtc
  } | Sort-Object
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Content -Path $prog -Value '' -Encoding UTF8
if (Test-Path $done) { Remove-Item $done -Force }
Log 'P9DANCE START'

try {
  $old = (Get-ChildItem $env:USERPROFILE\Desktop | Where-Object { $_.PSIsContainer -and $_.Name -like '*0.1.0*' } | Select-Object -First 1).FullName
  $v2  = (Get-ChildItem $env:USERPROFILE\Desktop | Where-Object { $_.PSIsContainer -and $_.Name -like '*-v2' } | Select-Object -First 1).FullName
  $out = Join-Path $v2 'dist-portable'
  $exeNew = Get-ChildItem $out -Filter *.exe | Where-Object { $_.Name -like '*mcp*v2*' } | Select-Object -First 1
  $oldExe = Get-ChildItem $old -Filter *.exe | Where-Object { $_.Name -like '*mcp*' -and $_.Name -notlike '*-v2*' } | Select-Object -First 1
  $verify = Join-Path $v2 'tools\verify.ps1'
  Log ('old=' + $old + ' v2=' + $v2 + ' exeNew=' + $exeNew.Name)

  $before = Baseline $old
  $before | Set-Content -Path 'C:\Users\Administrator\p9-baseline-before.txt' -Encoding UTF8
  Log ('baseline before files=' + $before.Count)

  Log 'stop apps + tunnel'
  Stop-Process -Name 'mcp' -Force -ErrorAction SilentlyContinue
  Get-Process | Where-Object { $_.ProcessName -like '*mcp*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  KillTunnel
  Start-Sleep -Seconds 1

  Log 'start v2 exe'
  Start-Process -FilePath $exeNew.FullName -WorkingDirectory $out
  $up = WaitPort 20
  if (-not $up) { throw 'v2 exe port not up' }
  Log 'v2 up'
  Start-Sleep -Seconds 3

  Log 'run verify.ps1'
  $vout = & powershell -NoProfile -ExecutionPolicy Bypass -File $verify 2>&1 | Out-String
  $vcode = $LASTEXITCODE
  Log ('verify exit=' + $vcode)

  Log 'stop v2 + tunnel, restart 0.1.0'
  Get-Process | Where-Object { $_.ProcessName -like '*mcp*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  KillTunnel
  Start-Sleep -Seconds 1
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $oldExe.FullName -WorkingDirectory $old
  $up2 = WaitPort 20
  Log ('0.1.0 back=' + $up2)

  $after = Baseline $old
  $after | Set-Content -Path 'C:\Users\Administrator\p9-baseline-after.txt' -Encoding UTF8
  $diff = Compare-Object $before $after
  $unchanged = ($null -eq $diff)
  Log ('baseline unchanged=' + $unchanged + ' files=' + $after.Count)

  $md = @()
  $md += '# P9 verify.ps1 结果存档（docs/verify-p9.md）'
  $md += ''
  $md += ('- 时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  $md += ('- 产物：v2\dist-portable\（exe=六本豆mcp-v2.exe，resources\app.asar 由 v2\src 打包，' + (Get-Item (Join-Path $out 'resources\app.asar')).Length + ' 字节）')
  $md += '- 运行时来源：0.1.0 便携版目录（只读复制；本次核验其未被改动）'
  $md += '- 测试实例：dist-portable\六本豆mcp-v2.exe（验证后已停止并恢复 0.1.0）'
  $md += ''
  $md += '## verify.ps1 五项检查输出'
  $md += ''
  $md += '```'
  $md += $vout.Trim()
  $md += '```'
  $md += ''
  $md += ('verify 退出码：' + $vcode + $(if ($vcode -eq 0) { '（全过）' } else { '（有失败项，见上）' }))
  $md += ''
  $md += '## 0.1.0 便携版目录未改动核验'
  $md += ''
  $md += ('- 文件数：' + $before.Count + ' -> ' + $after.Count)
  $md += ('- 名称/大小/修改时间全量比对：' + $(if ($unchanged) { '**完全一致（未被改动）**' } else { '**存在差异**' }))
  if (-not $unchanged) {
    $md += ''
    $md += '```'
    $md += ($diff | Out-String).Trim()
    $md += '```'
  }
  $md += ''
  $md += '## 说明'
  $md += ''
  $md += '- 打包/验证前已 Stop-Process 关闭应用（窗口 × 只会缩托盘）。'
  $md += '- 附基线明细 p9-baseline-before.txt / p9-baseline-after.txt（同目录）。'
  ($md -join "`r`n") | Set-Content -Path 'C:\Users\Administrator\p9-verify.md' -Encoding UTF8

  # 拷回 v2
  Copy-Item 'C:\Users\Administrator\p9-verify.md' (Join-Path $v2 'docs\verify-p9.md') -Force
  Copy-Item 'C:\Users\Administrator\p9-baseline-before.txt' (Join-Path $v2 'p9-baseline-before.txt') -Force
  Copy-Item 'C:\Users\Administrator\p9-baseline-after.txt' (Join-Path $v2 'p9-baseline-after.txt') -Force
  Copy-Item $prog (Join-Path $v2 'p9-progress.txt') -Force

  $status = if ($vcode -eq 0 -and $unchanged) { 'OK verify=all-pass old-dir=unchanged' } else { "PARTIAL verify=$vcode unchanged=$unchanged" }
  Set-Content -Path $done -Value $status -Encoding UTF8
  Copy-Item $done (Join-Path $v2 'p9-done.txt') -Force
  Log ('DONE ' + $status)
} catch {
  Log ('ERROR ' + $_.Exception.Message)
  Set-Content -Path $done -Value ('ERROR ' + $_.Exception.Message) -Encoding UTF8
  Get-Process | Where-Object { $_.ProcessName -like '*mcp*v2*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  KillTunnel
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $old2 = (Get-ChildItem $env:USERPROFILE\Desktop | Where-Object { $_.PSIsContainer -and $_.Name -like '*0.1.0*' } | Select-Object -First 1).FullName
  Start-Process -FilePath (Get-ChildItem $old2 -Filter *.exe | Where-Object { $_.Name -like '*mcp*' -and $_.Name -notlike '*-v2*' } | Select-Object -First 1).FullName -WorkingDirectory $old2 -ErrorAction SilentlyContinue
  Log 'recovery restart attempted'
}
