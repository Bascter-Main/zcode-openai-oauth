@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\@electron\asar\package.json" (
  echo Installing patch dependency...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [FAIL] npm install failed. Install Node.js 18 or later and try again.
    pause
    exit /b 1
  )
)

node patch.js %*
pause
