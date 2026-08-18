#!/bin/bash
set -euo pipefail

LABEL="com.bananamall.ai-product-workflow"
IMAGE_LABEL="com.bananamall.image-workshop"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${BANANA_WORKFLOW_HOME:-$HOME/Library/Application Support/BananaMallWorkflow}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
IMAGE_PLIST="$HOME/Library/LaunchAgents/$IMAGE_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/BananaMall"
DOMAIN="gui/$(id -u)"

"$PROJECT_ROOT/scripts/deploy-local-workflow-runtime.sh" >/dev/null
mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_ROOT/start-local-workflow.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_ROOT/runtime</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/workflow.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/workflow-error.log</string>
</dict>
</plist>
EOF

cat > "$IMAGE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$IMAGE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_ROOT/start-local-image-workshop.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_ROOT/data/image-workshop</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/image-workshop.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/image-workshop-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN/$IMAGE_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl bootstrap "$DOMAIN" "$IMAGE_PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl enable "$DOMAIN/$IMAGE_LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$IMAGE_LABEL"

printf '%s\n%s\n' "$PLIST" "$IMAGE_PLIST"
