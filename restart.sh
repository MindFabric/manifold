#!/bin/bash
pkill -f "electron ." 2>/dev/null
sleep 0.5
cd "$(dirname "$0")" && npm start &
