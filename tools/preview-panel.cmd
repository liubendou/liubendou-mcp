@echo off
rem Start the v2 panel preview (isolated port 8799) and open it in the browser.
cd /d "%~dp0.."
start "liubendou-preview" /min cmd /c "node tools\panel-preview.js"
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:8799/
echo Preview panel: http://127.0.0.1:8799/  (close the small console window to stop)
