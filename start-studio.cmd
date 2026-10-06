@echo off
rem Multi-Agent Studio launcher. Close this window to stop the Studio.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
node studio\server.mjs
if errorlevel 1 pause
