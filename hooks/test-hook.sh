#!/usr/bin/env bash
# Manual smoke test: send one synthetic event of each hook type at the local
# tracker and verify the script exits 0 fast. Usage: bash hooks/test-hook.sh
set -e
cd "$(dirname "$0")"
for t in PreToolUse PostToolUse Stop SubagentStop SessionStart SessionEnd Notification; do
  START=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo '{"session_id":"hook-smoke-test","tool_name":"Read","tool_input":{"file_path":"/tmp/x"},"cwd":"/tmp/hook-smoke"}' \
    | CLAUDE_HOOK_TYPE="$t" CLAUDE_CODE_ENTRYPOINT=cli bash agent-monitor-hook.sh
  RC=$?
  END=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo "$t: exit=$RC $((END-START))ms"
done
echo "OK — smoke rows land in session hook-smoke-test (retention will age them out)"
