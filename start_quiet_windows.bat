@echo off
cd /d "%~dp0"
echo Manual fallback: the floating posture CAT normally starts with start_windows.bat.
echo Start start_windows.bat first and open http://localhost:8000.
echo Camera and work session start automatically. Keep the browser open.
echo The cat grows with poor posture, and disappears when tracking stops.
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe backend\desktop_guard.py
) else (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3 backend\desktop_guard.py
  ) else (
    python backend\desktop_guard.py
  )
)
pause
