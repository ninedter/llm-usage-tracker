#!/usr/bin/env bash
# Claude Code Hook: ship through the local edge shipper (edge/README.md).
#
# Same payload and the same one-process-per-event cost as agent-monitor-hook.sh
# — the only difference is where it goes: the loopback edge intake, which
# spools to disk and forwards to the hub over Tailscale. That is what lets the
# hub live on another machine without mounting this machine's ~/.claude, and
# what keeps events through a network outage.
#
# Env: EDGE_INTAKE_URL (default http://127.0.0.1:3799), plus the usual
# CLAUDE_HOOK_TYPE / CLAUDE_CODE_ENTRYPOINT.
set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Guard before exec for the same reason agent-monitor-hook.sh does: a failed
# `exec` would exit non-zero and surface an error inside Claude Code.
[ -r "$HOOK_DIR/agent-monitor-hook.sh" ] || exit 0
# MONITOR_URL is the existing "one explicit target, no port discovery" path in
# agent-monitor-hook.py, so the edge needs no new hook logic at all.
export MONITOR_URL="${EDGE_INTAKE_URL:-http://127.0.0.1:3799}"
exec bash "$HOOK_DIR/agent-monitor-hook.sh" || exit 0
