@echo off
cd /d "%~dp0"
rem Prefer the project's virtual environment, where graphify is usually installed.
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
"%PY%" server.py %*
if errorlevel 1 pause
