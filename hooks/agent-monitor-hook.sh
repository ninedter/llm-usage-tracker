#!/usr/bin/env bash
# Claude Code Hook: Agent Monitor
# Captures all hook events and posts them to the LLM Usage Tracker monitor API.
#
# Handles all 7 hook event types:
#   PreToolUse, PostToolUse, Stop, SubagentStop,
#   SessionStart, SessionEnd, Notification
#
# Usage: Set up in ~/.claude/settings.json under "hooks" configuration.
# The hook reads JSON from stdin (provided by Claude Code) and forwards to the monitor API.
#
# Environment variables:
#   MONITOR_URL            - Full base URL override (e.g. https://xxx.trycloudflare.com)
#   CLAUDE_CODE_ENTRYPOINT - "claude-desktop" or "cli" (set by Claude Code)
#   CLAUDE_PROJECT_DIR     - Project directory (set by Claude Code)
#   CLAUDE_HOOK_TYPE       - Hook event type (set by our settings.json command prefix)

# Never block Claude Code
trap 'exit 0' ERR
set -uo pipefail

# Read the hook payload from stdin
PAYLOAD=$(cat)

# --- Determine the monitor base URL ---
if [ -n "${MONITOR_URL:-}" ]; then
  BASE_URL="${MONITOR_URL}/api/monitor"
else
  MONITOR_HOST="127.0.0.1"

  # Auto-detect port from the Electron app's port file
  PORT_FILE="$HOME/Library/Application Support/llm-usage-tracker/server-port"
  if [ -f "$PORT_FILE" ]; then
    MONITOR_PORT=$(cat "$PORT_FILE")
  else
    MONITOR_PORT=3000
  fi

  BASE_URL="http://${MONITOR_HOST}:${MONITOR_PORT}/api/monitor"
fi

# Quick connectivity check — bail silently if monitor is down
if [ -n "${MONITOR_URL:-}" ]; then
  curl -s --head --connect-timeout 1 --max-time 2 "${BASE_URL}/../health" >/dev/null 2>&1 || exit 0
else
  nc -z "${MONITOR_HOST:-127.0.0.1}" "${MONITOR_PORT:-3000}" 2>/dev/null || exit 0
fi

# --- Parse the payload once via python3, emit a JSON body to POST ---
HOOK_TYPE="${CLAUDE_HOOK_TYPE:-unknown}"

POST_BODY=$(echo "$PAYLOAD" | python3 -c "
import sys, json, os

d = json.load(sys.stdin)

hook_type = os.environ.get('CLAUDE_HOOK_TYPE', 'unknown')
session_id = d.get('session_id', d.get('agent_id', 'unknown'))
cwd = d.get('cwd', '')
project = os.path.basename(cwd) if cwd else ''
entrypoint = os.environ.get('CLAUDE_CODE_ENTRYPOINT', 'unknown')
tool_name = d.get('tool_name', '')
tool_input = d.get('tool_input', {})
tool_result = d.get('tool_result', '')

# Build files_affected from tool_input
files = []
if isinstance(tool_input, dict):
    for k in ('file_path', 'path', 'command', 'pattern'):
        v = tool_input.get(k, '')
        if v and '/' in str(v):
            files.append(str(v))

# Determine event_type, summary, and content based on hook type
event_type = ''
summary = ''
content = ''

if hook_type == 'PreToolUse':
    event_type = 'tool_call'
    # Build summary from tool input
    desc = tool_input.get('description', tool_input.get('command', '')) if isinstance(tool_input, dict) else ''
    summary = str(desc)[:200]
    content = json.dumps(tool_input)[:2000] if tool_input else ''

    # If this is an Agent (subagent) tool call, enrich with subagent info
    if tool_name == 'Agent':
        sub_desc = tool_input.get('description', '') if isinstance(tool_input, dict) else ''
        sub_type = tool_input.get('subagent_type', 'agent') if isinstance(tool_input, dict) else 'agent'
        event_type = 'subagent_start'
        summary = f'Subagent ({sub_type}): {sub_desc}'[:200]

elif hook_type == 'PostToolUse':
    event_type = 'tool_result'
    desc = tool_input.get('description', tool_input.get('command', '')) if isinstance(tool_input, dict) else ''
    summary = str(desc)[:200]
    if isinstance(tool_result, str):
        content = tool_result[:2000]
    else:
        content = json.dumps(tool_result)[:2000]

elif hook_type == 'Stop':
    event_type = 'stop'
    summary = 'Agent stopped — waiting for user input'
    # Stop reason may appear in tool_result or a dedicated field
    stop_reason = d.get('stop_reason', '')
    content = str(stop_reason)[:2000] if stop_reason else ''

elif hook_type == 'SubagentStop':
    event_type = 'subagent_stop'
    sub_desc = tool_input.get('description', '') if isinstance(tool_input, dict) else ''
    sub_type = tool_input.get('subagent_type', 'agent') if isinstance(tool_input, dict) else 'agent'
    summary = f'Subagent finished ({sub_type}): {sub_desc}'[:200]
    if isinstance(tool_result, str):
        content = tool_result[:2000]
    else:
        content = json.dumps(tool_result)[:2000]

elif hook_type == 'SessionStart':
    event_type = 'session_start'
    summary = f'Session started in {project}' if project else 'Session started'
    content = json.dumps({
        'cwd': cwd,
        'entrypoint': entrypoint,
        'permission_mode': d.get('permission_mode', ''),
    })

elif hook_type == 'SessionEnd':
    event_type = 'session_end'
    summary = f'Session ended in {project}' if project else 'Session ended'
    content = ''

elif hook_type == 'Notification':
    event_type = 'notification'
    # Extract notification text from wherever Claude Code puts it
    message = d.get('message', d.get('notification', d.get('tool_result', '')))
    if isinstance(message, dict):
        message = json.dumps(message)
    message = str(message)

    # Detect compaction patterns
    compaction_keywords = ['compact', 'compress', 'context reduced', 'compaction', 'context window']
    if any(kw in message.lower() for kw in compaction_keywords):
        event_type = 'compaction'
        summary = 'Context compaction detected'
    else:
        summary = message[:200]
    content = message[:2000]

else:
    # Unknown hook type — forward generically
    event_type = hook_type.lower()
    summary = f'Hook event: {hook_type}'
    content = json.dumps(d)[:2000]

body = {
    'agent_id': session_id,
    'session_id': session_id,
    'event_type': event_type,
    'tool_name': tool_name,
    'summary': summary,
    'content': content,
    'files_affected': files,
    'agent_project': project,
    'agent_entrypoint': entrypoint,
    'agent_cwd': cwd,
}

print(json.dumps(body))
" 2>/dev/null) || exit 0

# --- POST to the monitor API ---
curl -s -X POST "${BASE_URL}/events" \
  -H "Content-Type: application/json" \
  -d "$POST_BODY" \
  --connect-timeout 2 --max-time 5 >/dev/null 2>&1 || true

exit 0
