#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
AGGREGATOR_PATH="${PLUGIN_ROOT}/src/eslint-aggregator.mjs"
PLIST_PATH="${HOME}/Library/LaunchAgents/ai.darian.eslint-aggregator.plist"
PORT=7475
AUTH_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"

launchctl setenv CLAUDE_CODE_SSE_PORT "${PORT}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.darian.eslint-aggregator</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>${AGGREGATOR_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ESLINT_IDE_PORT</key>
    <string>${PORT}</string>
    <key>ESLINT_AUTH_TOKEN</key>
    <string>${AUTH_TOKEN}</string>
    <key>CLAUDE_CODE_SSE_PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${HOME}/.claude/logs/eslint-aggregator.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.claude/logs/eslint-aggregator.log</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

mkdir -p "${HOME}/.claude/logs"

if launchctl list ai.darian.eslint-aggregator &>/dev/null; then
  launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null || true
fi

launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"

echo ""
echo "eslint-aggregator installed and started on port ${PORT}."
echo "Auth token saved to plist (persists across restarts)."
echo ""
echo "Restart Claude Code for the IDE integration to take effect."
