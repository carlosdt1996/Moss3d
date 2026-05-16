@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo  Moss3D - Production Launcher
echo ================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download it from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/3] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

if not exist "out\main\index.js" (
    echo [2/3] Building the app...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed.
        pause
        exit /b 1
    )
    echo.
)

if not exist "resources\python-embed\python.exe" (
    echo [3/3] Downloading bundled Python - about 80 MB, one-time...
    call npm run prepare-resources
    if errorlevel 1 (
        echo [ERROR] prepare-resources failed.
        pause
        exit /b 1
    )
    echo.
)

if not exist "out\builtin-extensions\unirig\.unirig-ready" (
    echo [optional] Installing UniRig for workflow rigging...
    echo           Ctrl+C to skip if you do not need the rig node.
    call npm run setup-unirig
    if errorlevel 1 (
        echo [WARN] UniRig setup failed - rig node unavailable until setup succeeds.
    )
    echo.
)

echo Launching Moss3D...
call npm run preview
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] Moss3D exited with code %EXIT_CODE%
    pause
    exit /b %EXIT_CODE%
)

endlocal
