@echo off
rem One-time setup for Albert Chat. Requires Python 3.12 (py launcher or pyenv-win).
rem The venv is built from 3.12 explicitly: the default python on this box may be newer
rem than Chainlit supports.
if not exist "%~dp0.venv\Scripts\python.exe" (
  py -3.12 -m venv "%~dp0.venv" || (echo Python 3.12 not found: install it via pyenv-win or python.org, then re-run. & exit /b 1)
)
"%~dp0.venv\Scripts\python.exe" --version | findstr /c:" 3.12" >nul || (echo chat\.venv is not Python 3.12. Delete it and re-run setup.cmd. & exit /b 1)
"%~dp0.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r "%~dp0requirements.txt" || exit /b 1
echo.
echo Done. Start the chat UI with start.cmd
