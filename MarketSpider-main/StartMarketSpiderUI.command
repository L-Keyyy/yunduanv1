#!/bin/bash
set -e

cd "$(dirname "$0")"
mkdir -p logs

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  PYTHON_BIN="python"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] launch web ui with $PYTHON_BIN" >> logs/ui_launcher.log
"$PYTHON_BIN" MarketSpider_WebUI.py
