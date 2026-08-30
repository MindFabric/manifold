#!/bin/bash
# Build Manifold for Windows and install it from WSL
# Usage: bash install.sh

set -e

PROJ_DIR="C:\\Users\\User\\Documents\\GitHub\\manifold"
DIST_DIR="/mnt/c/Users/User/Documents/GitHub/manifold/dist"

echo "Building Manifold for Windows..."
cmd.exe /c "cd /d $PROJ_DIR && npm run build:win" 2>&1

# Get version from package.json
VERSION=$(grep -o '"version": *"[^"]*"' /mnt/c/Users/User/Documents/GitHub/manifold/package.json | head -1 | grep -o '[0-9][^"]*')
INSTALLER="Manifold Setup ${VERSION}.exe"

if [ ! -f "$DIST_DIR/$INSTALLER" ]; then
    echo "ERROR: Installer not found at $DIST_DIR/$INSTALLER"
    exit 1
fi

echo "Built: $INSTALLER ($(du -h "$DIST_DIR/$INSTALLER" | cut -f1))"
echo "Installing..."
powershell.exe -Command "Start-Process '$PROJ_DIR\\dist\\$INSTALLER' -Verb RunAs"
echo "Installer launched — approve the UAC prompt to finish."
