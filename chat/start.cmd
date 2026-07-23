@echo off
rem Albert Chat on http://127.0.0.1:4401. Runs in the foreground: closing this window
rem stops it (no scheduled task in v1; see README).
if not exist "%~dp0.venv\Scripts\chainlit.exe" (echo Run setup.cmd first. & exit /b 1)
rem Open the browser after a short delay so the server is already listening.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:4401/"
"%~dp0.venv\Scripts\chainlit.exe" run "%~dp0app.py" --host 127.0.0.1 --port 4401 --headless %*
