#!/usr/bin/env bash
# Register a new agent with the monitor.
# Called at the start of a Claude Code session or when a subagent is spawned.
#
# Usage: echo '{"id":"...","session_id":"...","type":"..."}' | ./register-agent.sh
#
# Or call directly:
#   ./register-agent.sh --id "abc123" --session-id "sess1" --type "main" --description "Working on feature X"

set -euo pipefail

if [ -n "${MONITOR_URL:-}" ]; then
  BASE_URL="${MONITOR_URL}/api/monitor"
else
  MONITOR_HOST="${MONITOR_HOST:-127.0.0.1}"
  MONITOR_PORT="${MONITOR_PORT:-3123}"
  BASE_URL="http://${MONITOR_HOST}:${MONITOR_PORT}/api/monitor"
fi

# Quick connectivity check
if [ -n "${MONITOR_URL:-}" ]; then
  curl -s --head --connect-timeout 1 --max-time 2 "${BASE_URL}/../health" >/dev/null 2>&1 || exit 0
else
  nc -z "${MONITOR_HOST:-127.0.0.1}" "${MONITOR_PORT:-3123}" 2>/dev/null || exit 0
fi

# Parse args or read from stdin
if [ $# -gt 0 ]; then
  AGENT_ID=""
  SESSION_ID=""
  AGENT_TYPE="main"
  DESCRIPTION=""
  PARENT_ID=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --id) AGENT_ID="$2"; shift 2 ;;
      --session-id) SESSION_ID="$2"; shift 2 ;;
      --type) AGENT_TYPE="$2"; shift 2 ;;
      --description) DESCRIPTION="$2"; shift 2 ;;
      --parent-id) PARENT_ID="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Generate IDs if not provided
  if [ -z "$AGENT_ID" ]; then
    AGENT_ID=$(python3 -c "import uuid; print(str(uuid.uuid4())[:12])" 2>/dev/null || echo "agent-$$")
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(python3 -c "import uuid; print(str(uuid.uuid4())[:12])" 2>/dev/null || echo "sess-$$")
  fi

  BODY="{\"id\":\"${AGENT_ID}\",\"session_id\":\"${SESSION_ID}\",\"type\":\"${AGENT_TYPE}\",\"description\":$(echo "$DESCRIPTION" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null || echo '""')"
  if [ -n "$PARENT_ID" ]; then
    BODY="${BODY},\"parent_agent_id\":\"${PARENT_ID}\""
  fi
  BODY="${BODY}}"

  curl -s -X POST "${BASE_URL}/agents" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    --connect-timeout 2 --max-time 5

else
  # Read from stdin
  PAYLOAD=$(cat)
  curl -s -X POST "${BASE_URL}/agents" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 2 --max-time 5
fi
