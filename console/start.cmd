@echo off
rem Open the browser after a 1s delay so the server is already listening.
start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://127.0.0.1:4400/"
node "%~dp0server.mjs" %*
