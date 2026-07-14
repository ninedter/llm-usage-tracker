#!/usr/bin/env bash
# Claude Code Hook: Agent Monitor — thin wrapper.
# All logic lives in agent-monitor-hook.py (single process per event instead
# of cat+nc+python+curl). Env contract unchanged: MONITOR_URL,
# DOCKER_MONITOR_PORT, CLAUDE_HOOK_TYPE, CLAUDE_CODE_ENTRYPOINT.
#
# Guard before exec: bash's `exec` builtin, when it can't find/run its target,
# terminates a non-interactive shell immediately (exit 126/127) WITHOUT ever
# evaluating a trailing `|| exit 0` -- so a bare `exec python3 ...` would break
# the "always exit 0, never surface an error to Claude Code" contract if
# python3 were ever missing from PATH. `command -v` is a shell builtin (no
# fork), so this guard keeps the wrapper at exactly one process in the normal
# case while closing that gap.
command -v python3 >/dev/null 2>&1 || exit 0
exec /usr/bin/env python3 -S "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-monitor-hook.py" 2>/dev/null || exit 0
