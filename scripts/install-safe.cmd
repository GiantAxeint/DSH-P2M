@echo off
setlocal EnableExtensions
REM ============================================================
REM  DSH-P2M: install upgraded crash-safe launcher (dsh-safe v2)
REM  - Backs up the existing launcher, then copies v2 into place.
REM  - Adjust DSH_DIR below if your DSH install directory differs.
REM  - Safe to re-run: it backs up whatever exists each time.
REM ============================================================

set "DSH_DIR=E:\DeepseekHome"

if not exist "%DSH_DIR%" (
    echo [ERROR] DSH directory not found: %DSH_DIR%
    echo         Edit DSH_DIR at the top of this script and run again.
    pause
    exit /b 1
)

set "SRC=%~dp0..\launcher\dsh-safe.mjs"
if not exist "%SRC%" (
    echo [ERROR] launcher source not found: %SRC%
    pause
    exit /b 1
)

if exist "%DSH_DIR%\dsh-safe.mjs" (
    for /f "tokens=2 delims==." %%a in ('wmic os get localdatetime /value ^| find "="') do set "STAMP=%%a"
    copy /Y "%DSH_DIR%\dsh-safe.mjs" "%DSH_DIR%\dsh-safe.mjs.bak-%STAMP%" >nul
    echo [OK] old launcher backed up to dsh-safe.mjs.bak-%STAMP%
)

copy /Y "%SRC%" "%DSH_DIR%\dsh-safe.mjs" >nul
echo [OK] dsh-safe v2 installed to %DSH_DIR%\dsh-safe.mjs
echo.
echo Next: start DSH via DSH-safe.cmd as usual. First run migrates the
echo legacy plugin-guard.yml into <DSH_HOME>\p2m\plugin-guard.yml
echo (default DSH_HOME = C:\Users\%USERNAME%\.dsh).
echo.
pause
