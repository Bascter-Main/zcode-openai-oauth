@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js 18 or later is required.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js 18 or later is required.
  pause
  exit /b 1
)

node -e "try{const p=require('./package.json');process.exit(require('./node_modules/@electron/asar/package.json').version===p.dependencies['@electron/asar']?0:1)}catch{process.exit(1)}" >nul 2>nul
if errorlevel 1 (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] npm is required to install the patch dependency.
    pause
    exit /b 1
  )
  echo Installing locked patch dependency...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [FAIL] npm ci failed. Check the network connection and try again.
    pause
    exit /b 1
  )
)

node patch.js %*
pause
