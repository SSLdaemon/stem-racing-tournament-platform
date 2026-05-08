@echo off
setlocal

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer with npm is required.
  echo Download it from https://nodejs.org/
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

echo Starting STEM Racing Tournament Platform...
call npm start
