# build.ps1 - 关闭应用 -> 打包源码到 app.asar -> 重启应用
# 用法: pwsh -File build.ps1 [-NoRestart]
param([switch]$NoRestart)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $root '源码'
$portable= 'C:\Users\Administrator\Desktop\本地AI遥控台-0.1.0-win-x64-便携版'
$asar    = Join-Path $portable 'resources\app.asar'
$exe     = Join-Path $portable '六本豆mcp.exe'

Write-Host '[1/5] 关闭应用 ...' -ForegroundColor Cyan
Stop-Process -Name '六本豆mcp' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host '[2/5] 打包 asar ...' -ForegroundColor Cyan
npx --yes '@electron/asar@3' pack $src $asar
if ($LASTEXITCODE -ne 0) { throw "asar pack 失败 (exit $LASTEXITCODE)" }

$size = (Get-Item $asar).Length
Write-Host "      app.asar = $size 字节" -ForegroundColor Green

Write-Host '[3/5] 确认没有 resources\app 目录抢占 ...' -ForegroundColor Cyan
$appDir = Join-Path $portable 'resources\app'
if (Test-Path $appDir) {
  Write-Warning "发现 $appDir ，它会优先于 app.asar 被加载！"
  Write-Warning '若这是开发残留，请删除后再发版。'
}

if ($NoRestart) { Write-Host '[4/5] 跳过重启 (-NoRestart)' -ForegroundColor Yellow; return }

Write-Host '[4/5] 启动应用 ...' -ForegroundColor Cyan
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -WorkingDirectory $portable

Write-Host '[5/5] 等待端口就绪 ...' -ForegroundColor Cyan
$ok = $false
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "      端口 8765 就绪，耗时 $([math]::Round($i*0.5,1))s" -ForegroundColor Green
    $ok = $true; break
  }
}
if (-not $ok) { throw '启动 15s 后端口仍未监听，请检查 exe 是否被安全软件拦截' }

Write-Host '完成。可用 工具\verify.ps1 做端到端检查。' -ForegroundColor Green