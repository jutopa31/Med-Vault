#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="/home/jutopa/MedVault/scripts"
LOG_DIR="/home/jutopa/MedVault/automatizaciones/logs"
LOCK_FILE="/tmp/ospedyc-confirmations.lock"
NODE_BIN="/usr/bin/node"
WATCHER="$SCRIPT_DIR/watch-ospedyc-confirmations.js"

mkdir -p "$LOG_DIR"

if command -v flock >/dev/null 2>&1; then
  exec flock -n "$LOCK_FILE" "$NODE_BIN" "$WATCHER" >> "$LOG_DIR/ospedyc-confirmations.log" 2>&1
fi

exec "$NODE_BIN" "$WATCHER" >> "$LOG_DIR/ospedyc-confirmations.log" 2>&1
