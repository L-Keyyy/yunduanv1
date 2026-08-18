#!/bin/bash
set -euo pipefail

INSTALL_ROOT="${BANANA_WORKFLOW_HOME:-$HOME/Library/Application Support/BananaMallWorkflow}"
cd "$INSTALL_ROOT/data/image-workshop"

export CHROME_DEVTOOLS_BASE="${CHROME_DEVTOOLS_BASE:-http://127.0.0.1:9222}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec /usr/bin/python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 8010
