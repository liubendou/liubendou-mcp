# verify.ps1 - 五项端到端检查
# 用法: pwsh -File verify.ps1

$ErrorActionPreference = 'Continue'
$panel = 'http://127.0.0.1:8766'
$pass = 0; $fail = 0
function Check($name, [scriptblock]$body) {
  try {
    $r = & $body
    if ($r) { Write-Host "  [PASS] $name" -ForegroundColor Green; $script:pass++ }
    else    { Write-Host "  [FAIL] $name" -ForegroundColor Red;   $script:fail++ }
  } catch {
    Write-Host "  [FAIL] $name -> $($_.Exception.Message)" -ForegroundColor Red
    $script:fail++
  }
}

Write-Host '=== 1. 端口 ===' -ForegroundColor Cyan
foreach ($p in 8765, 8766) {
  Check "端口 $p 在监听" {
    [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  }
}

Write-Host '=== 2. 应用状态 ===' -ForegroundColor Cyan
$status = $null
Check '/api/status 可访问' {
  $script:status = Invoke-RestMethod "$panel/api/status" -TimeoutSec 5
  $true
}
if ($status) { Write-Host "       version=$($status.version)" -ForegroundColor DarkGray }

Write-Host '=== 3. 公网隧道 ===' -ForegroundColor Cyan
$tunnel = $null
Check '/api/tunnel-check 全部 ok' {
  $script:tunnel = Invoke-RestMethod "$panel/api/tunnel-check" -TimeoutSec 20
  $script:tunnel.ok
}
if ($tunnel) {
  foreach ($s in $tunnel.steps) {
    $c = if ($s.ok) { 'Green' } else { 'Red' }
    Write-Host "       $($s.label): $($s.detail)" -ForegroundColor $c
  }
}

Write-Host '=== 4. MCP 端点 ===' -ForegroundColor Cyan
Check '本地 MCP initialize 200' {
  $cfg = Invoke-RestMethod "$panel/api/config" -TimeoutSec 5
  $body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}'
  $r = Invoke-WebRequest "http://127.0.0.1:8765/mcp/$($cfg.token)" -Method POST -Body $body `
        -ContentType 'application/json' -TimeoutSec 10 -UseBasicParsing
  Write-Host "       HTTP $($r.StatusCode), session=$($r.Headers['mcp-session-id'])" -ForegroundColor DarkGray
  $r.StatusCode -eq 200
}

Write-Host '=== 5. SSH 反向隧道 ===' -ForegroundColor Cyan
Check '存在 -R 8765 的 ssh 进程' {
  $n = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*-R*8765*' }).Count
  $n -gt 0
}

Write-Host ''
$color = if ($fail -eq 0) { 'Green' } else { 'Red' }
Write-Host "结果: $pass 通过 / $fail 失败" -ForegroundColor $color
if ($fail -gt 0) { exit 1 }