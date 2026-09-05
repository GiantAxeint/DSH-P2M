@echo off
setlocal EnableExtensions
REM ============================================================
REM  DSH-P2M: install A-plugin (dsh-p2m) into a DSH profile via
REM  local link. Double-click to run, or pass a custom profile dir:
REM      install-plugin-link.cmd "D:\path\to\profile"
REM  Default profile: %USERPROFILE%\.dsh\profiles\web
REM  The script only edits the profile package.json (backed up),
REM  prints the pnpm command, then you restart DSH yourself.
REM ============================================================

set "REPO=%~dp0.."
set "PROFILE=%USERPROFILE%\.dsh\profiles\web"
if not "%~1"=="" set "PROFILE=%~1"

set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

echo [install] profile : %PROFILE%
echo [install] package : %REPO%
echo.

"%NODE%" "%REPO%\scripts\install-plugin-link.mjs" --profile-dir "%PROFILE%" --package-dir "%REPO%"
if errorlevel 1 (
    echo.
    echo [ERROR] installer failed. See messages above.
    pause
    exit /b 1
)

echo.
echo Then run inside the profile dir:  pnpm install
echo and restart DSH with DSH-safe.cmd. Entry id is p2m.
pause
