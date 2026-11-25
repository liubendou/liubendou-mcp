# build-v2.ps1 - 六本豆mcp v2 打包（P9）
# 与交接包 工具\build.ps1 的差异：产物目标改为 v2\dist-portable（绝不写 0.1.0 便携版目录），
# exe 改名为 六本豆mcp-v2.exe（D5），源码用 v2\src。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-v2.ps1 [-NoRestart] [-NoStop]
param([switch]$NoRestart, [switch]$NoStop)

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $PSScriptRoot          # v2 根
$src      = Join-Path $root 'src'                     # v2 源码（含 package.json）
$old      = 'C:\Users\Administrator\Desktop\本地AI遥控台-0.1.0-win-x64-便携版'   # 0.1.0 运行时来源（只读）
$out      = Join-Path $root 'dist-portable'           # v2 产物（独立目录）
$asar     = Join-Path $out 'resources\app.asar'
$exeOld   = Join-Path $out '六本豆mcp.exe'
$exeNew   = Join-Path $out '六本豆mcp-v2.exe'

Write-Host '[1/6] 关闭应用（避免文件锁）...' -ForegroundColor Cyan
if (-not $NoStop) {
  Stop-Process -Name '六本豆mcp' -Force -ErrorAction SilentlyContinue
  Stop-Process -Name '六本豆mcp-v2' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Write-Host '[2/6] 复制 0.1.0 运行时 -> dist-portable（首次）...' -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $out 'resources'))) {
  New-Item -ItemType Directory -Path $out -Force | Out-Null
  # robocopy 只读来源；排除 resources\app（开发目录会抢占 asar）与旧 asar（下面重打）
  robocopy $old $out /E /XD app /XF app.asar /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 (exit $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
} else {
  Write-Host '      已存在，跳过复制' -ForegroundColor DarkGray
}

Write-Host '[3/6] 打包 asar（v2\src -> dist-portable\resources\app.asar）...' -ForegroundColor Cyan
if (Test-Path $asar) { Remove-Item $asar -Force }
npx --yes '@electron/asar@3' pack $src $asar
if ($LASTEXITCODE -ne 0) { throw "asar pack 失败 (exit $LASTEXITCODE)" }
$size = (Get-Item $asar).Length
Write-Host "      app.asar = $size 字节" -ForegroundColor Green

Write-Host '[4/6] 确认没有 resources\app 目录抢占 ...' -ForegroundColor Cyan
$appDir = Join-Path $out 'resources\app'
if (Test-Path $appDir) {
  Write-Warning "发现 $appDir ，删除之（否则它会优先于 app.asar 被加载）"
  Remove-Item $appDir -Recurse -Force
}

Write-Host '[5/6] exe 改名 六本豆mcp-v2.exe ...' -ForegroundColor Cyan
if ((Test-Path $exeOld) -and -not (Test-Path $exeNew)) {
  Rename-Item $exeOld '六本豆mcp-v2.exe'
}
if (-not (Test-Path $exeNew)) { throw "未找到 $exeNew" }

if ($NoRestart) { Write-Host '[6/6] 跳过重启 (-NoRestart)' -ForegroundColor Yellow; return }

Write-Host '[6/6] 恢复 0.1.0 应用 ...' -ForegroundColor Cyan
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $old '六本豆mcp.exe') -WorkingDirectory $old
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if (-not $ok) { Write-Warning '0.1.0 应用 15s 后端口仍未监听' }
Write-Host 'build-v2 完成。' -ForegroundColor Green
