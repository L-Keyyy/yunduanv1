#!/bin/bash
set -euo pipefail

INSTALL_ROOT="${BANANA_WORKFLOW_HOME:-$HOME/Library/Application Support/BananaMallWorkflow}"
RUNTIME_ROOT="$INSTALL_ROOT/runtime"
cd "$RUNTIME_ROOT"

export HOSTNAME=127.0.0.1
export PORT=3000
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec /usr/local/bin/node server.js
