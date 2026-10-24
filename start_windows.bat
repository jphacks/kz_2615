@echo off
cd /d "%~dp0"
if exist .venv\Scripts\python.exe goto dependencies
set "ERGO_PYTHON="
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; assert sys.version_info >= (3,11)" >nul 2>&1
  if not errorlevel 1 set "ERGO_PYTHON=py -3"
)
if not defined ERGO_PYTHON (
  where python >nul 2>&1
  if not errorlevel 1 (
    python -c "import sys; assert sys.version_info >= (3,11)" >nul 2>&1
    if not errorlevel 1 set "ERGO_PYTHON=python"
  )
)
if not defined ERGO_PYTHON goto no_python
%ERGO_PYTHON% -m venv .venv
if errorlevel 1 goto failed
:dependencies
rem Install once; later launches work offline. Delete the .venv folder to reinstall.
if not exist .venv\.deps_ok (
  .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
  if errorlevel 1 goto failed
  echo ok> .venv\.deps_ok
)
.venv\Scripts\python.exe backend\run.py
pause
exit /b
:no_python
echo Python 3.11 or newer was not found.
echo Install Python 3.13 with the following command in CMD:
echo winget install --id Python.Python.3.13 -e --source winget
echo Close and reopen CMD after installing. Then run this file again.
pause
exit /b 1
:failed
echo Setup failed. Check Python installation and internet connection.
pause
