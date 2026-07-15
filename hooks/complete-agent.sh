#!/usr/bin/env bash
# Mark an agent as completed/failed in the monitor.
#
# Usage:
#   ./complete-agent.sh --id "abc123" --status "completed"
#   ./complete-agent.sh --id "abc123" --status "failed"

set -euo pipefail

if [ -n "${MONITOR_URL:-}" ]; then
  BASE_URL="${MONITOR_URL}/api/monitor"
else
  MONITOR_HOST="${MONITOR_HOST:-127.0.0.1}"
  MONITOR_PORT="${MONITOR_PORT:-3789}"
  BASE_URL="http://${MONITOR_HOST}:${MONITOR_PORT}/api/monitor"
fi

# Quick connectivity check
if [ -n "${MONITOR_URL:-}" ]; then
  curl -s --head --connect-timeout 1 --max-time 2 "${BASE_URL}/../health" >/dev/null 2>&1 || exit 0
else
  nc -z "${MONITOR_HOST:-127.0.0.1}" "${MONITOR_PORT:-3789}" 2>/dev/null || exit 0
fi

AGENT_ID=""
STATUS="completed"

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) AGENT_ID="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$AGENT_ID" ]; then
  echo "Error: --id is required" >&2
  exit 1
fi

curl -s -X PATCH "${BASE_URL}/agents/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"${STATUS}\"}" \
  --connect-timeout 2 --max-time 5
