@echo off
setlocal
cd /d "%~dp0"
if exist runtime\node.exe goto desktop
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci --no-fund --no-audit
  if errorlevel 1 exit /b 1
)
if not exist dist\index.js (
  call npm run build
  if errorlevel 1 exit /b 1
)
:desktop
start "" "%~dp0LiubendouLite.exe"
