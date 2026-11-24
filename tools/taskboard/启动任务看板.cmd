@echo off
setlocal
cd /d "%~dp0\..\.."
node tools/taskboard/server.mjs
if errorlevel 1 pause
