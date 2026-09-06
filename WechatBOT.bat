@echo off
cd /d "%~dp0"

call npm run build
if errorlevel 1 (
  echo Build failed. Bot was not started.
  pause
  exit /b 1
)

call npm start
