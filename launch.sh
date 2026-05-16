#!/bin/bash

echo " Moss3D — Production Launcher"
echo "================================"
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "        Download it from https://nodejs.org"
    exit 1
fi

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
    echo "[1/2] Installing dependencies..."
    npm install || { echo "[ERROR] npm install failed."; exit 1; }
    echo
fi

# Build if out/ is missing
if [ ! -d "out" ]; then
    echo "[2/3] Building the app..."
    npm run build || { echo "[ERROR] Build failed."; exit 1; }
    echo
fi

# Bundled Python (required on Windows; used by preview/production setup)
PYTHON_EMBED="resources/python-embed"
if [ "$(uname -s 2>/dev/null)" = "MINGW"* ] || [ "$(uname -s 2>/dev/null)" = "MSYS"* ] || [ "$(uname -s 2>/dev/null)" = "CYGWIN"* ]; then
    PYTHON_EXE="$PYTHON_EMBED/python.exe"
else
    PYTHON_EXE="$PYTHON_EMBED/bin/python3"
fi

if [ ! -f "$PYTHON_EXE" ]; then
    echo "[3/3] Downloading bundled Python (~80 MB, one-time)..."
    npm run prepare-resources || { echo "[ERROR] prepare-resources failed."; exit 1; }
    echo
fi

# UniRig (optional built-in rigging node)
if [ ! -f "out/builtin-extensions/unirig/.unirig-ready" ]; then
    echo "[optional] Installing UniRig for workflow rigging node..."
    echo "          Skip with Ctrl+C if you do not need rigging."
    npm run setup-unirig || echo "[WARN] UniRig setup failed — rig node unavailable until setup succeeds."
    echo
fi

# Launch
echo "Launching Moss3D..."
npm run preview
