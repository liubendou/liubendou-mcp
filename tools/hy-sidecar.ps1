# Hy-Memory sidecar 手动启动脚本（六本豆mcp v2 · P5）
# 用途：调试/手动托管 sidecar。v2 正式运行时由 src\dist\core\hySidecar.js 自动拉起，不需要跑本脚本。
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\hy-sidecar.ps1            # 默认端口 19527
#   powershell -ExecutionPolicy Bypass -File tools\hy-sidecar.ps1 -Port 19528
# 环境变量（尤其是 embedding 端点）写在 v2 根目录的 hy-memory.env，格式 KEY=VALUE，例如：
#   MEMORY_EMBEDDER_API_KEY=sk-xxxx
#   MEMORY_EMBEDDER_BASE_URL=https://api.openai.com/v1
#   MEMORY_EMBEDDER_MODEL=text-embedding-3-small
#   MEMORY_EMBEDDING_DIMS=1536
# （不要把 hy-memory.env 提交或外传；它含密钥。）
param(
    [int]$Port = 19527,
    [string]$DataDir = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# 1) 选 python：优先 venv-hy
$py = Join-Path $root "venv-hy\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
Write-Output ("[hy-sidecar] python = " + $py)

# 2) 检查 hy_memory
& $py -c "import hy_memory; print('[hy-sidecar] hy_memory', getattr(hy_memory,'__version__','ok'))"
if ($LASTEXITCODE -ne 0) { Write-Error "hy_memory 不可用，请先: pip install hy-memory==2.0.5"; exit 1 }

# 3) 加载 hy-memory.env（若存在）
$envFile = Join-Path $root "hy-memory.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $kv = $line -split "=", 2
            if ($kv.Count -eq 2) {
                $name = $kv[0].Trim()
                $val = $kv[1].Trim().Trim('"').Trim("'")
                Set-Item -Path ("Env:" + $name) -Value $val
            }
        }
    }
    Write-Output "[hy-sidecar] hy-memory.env loaded"
}

# 3.5) 模式：默认 lite（D1：只用 Embedding，不调 LLM）
if (-not $env:MEMORY_MODE) { $env:MEMORY_MODE = "lite" }
Write-Output ("[hy-sidecar] MEMORY_MODE = " + $env:MEMORY_MODE)

# 4) 数据目录
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA "Temp\hy-memory-sidecar" }
$env:MEMORY_DATA_DIR = Join-Path $DataDir "hy-memory"
Write-Output ("[hy-sidecar] MEMORY_DATA_DIR = " + $env:MEMORY_DATA_DIR)
Write-Output ("[hy-sidecar] starting on http://127.0.0.1:" + $Port)

# 5) 启动官方 server（不修改 SDK）
& $py -m hy_memory.server --port $Port --host 127.0.0.1
