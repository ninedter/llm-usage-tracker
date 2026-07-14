#!/usr/bin/env python3 -S
"""Claude Code hook -> LLM Usage Tracker. One process per event: parse stdin,
discover listening tracker instances, POST to each. Never blocks Claude Code:
every failure path exits 0 fast. -S skips site-packages for ~2-3x faster start."""
import http.client
import json
import os
import sys
import threading


def read_candidate_ports():
    ports = []
    port_file = os.path.expanduser(
        "~/Library/Application Support/llm-usage-tracker/server-port"
    )
    try:
        with open(port_file) as f:
            ports.append(int(f.read().strip()))
    except (OSError, ValueError):
        pass
    ports.append(int(os.environ.get("DOCKER_MONITOR_PORT", "3789")))
    ports.append(3000)
    seen, out = set(), []
    for p in ports:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def post_json(host, port, path, body, timeout, use_https=False):
    conn_cls = http.client.HTTPSConnection if use_https else http.client.HTTPConnection
    conn = conn_cls(host, port, timeout=timeout)
    try:
        conn.request(
            "POST", path, body=body, headers={"Content-Type": "application/json"}
        )
        conn.getresponse().read()
    finally:
        conn.close()


def post_bounded(fn, args, deadline_s):
    """Run a network post with a hard wall-clock bound. http.client's timeout
    doesn't cover DNS resolution (getaddrinfo), which can hang on a flaky
    resolver — and PreToolUse hooks block Claude Code's tool call while we
    wait. A daemon thread dies with the process, so we exit on deadline no
    matter what the resolver is doing."""
    t = threading.Thread(target=fn, args=args, daemon=True)
    t.start()
    t.join(deadline_s)


def build_body(d):
    hook_type = os.environ.get("CLAUDE_HOOK_TYPE", "unknown")
    session_id = d.get("session_id", d.get("agent_id", "unknown"))
    cwd = d.get("cwd", "")
    project = os.path.basename(cwd) if cwd else ""
    entrypoint = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "unknown")
    tool_name = d.get("tool_name", "")
    tool_input = d.get("tool_input", {})
    tool_result = d.get("tool_result", "")

    files = []
    if isinstance(tool_input, dict):
        for k in ("file_path", "path", "command", "pattern"):
            v = tool_input.get(k, "")
            if v and "/" in str(v):
                files.append(str(v))

    event_type = ""
    summary = ""
    content = ""

    if hook_type == "PreToolUse":
        event_type = "tool_call"
        desc = (
            tool_input.get("description", tool_input.get("command", ""))
            if isinstance(tool_input, dict)
            else ""
        )
        summary = str(desc)[:200]
        content = json.dumps(tool_input)[:2000] if tool_input else ""
        if tool_name == "Agent":
            sub_desc = tool_input.get("description", "") if isinstance(tool_input, dict) else ""
            sub_type = tool_input.get("subagent_type", "agent") if isinstance(tool_input, dict) else "agent"
            event_type = "subagent_start"
            summary = f"Subagent ({sub_type}): {sub_desc}"[:200]

    elif hook_type == "PostToolUse":
        event_type = "tool_result"
        desc = (
            tool_input.get("description", tool_input.get("command", ""))
            if isinstance(tool_input, dict)
            else ""
        )
        summary = str(desc)[:200]
        content = tool_result[:2000] if isinstance(tool_result, str) else json.dumps(tool_result)[:2000]

    elif hook_type == "Stop":
        event_type = "stop"
        stop_reason = d.get("stop_reason", "")
        summary = (
            f"Agent stopped — {stop_reason}"
            if stop_reason
            else "Agent stopped — waiting for user input"
        )
        content = str(stop_reason)[:2000] if stop_reason else ""

    elif hook_type == "SubagentStop":
        event_type = "subagent_stop"
        sub_desc = tool_input.get("description", "") if isinstance(tool_input, dict) else ""
        sub_type = tool_input.get("subagent_type", "agent") if isinstance(tool_input, dict) else "agent"
        summary = f"Subagent finished ({sub_type}): {sub_desc}"[:200]
        content = tool_result[:2000] if isinstance(tool_result, str) else json.dumps(tool_result)[:2000]

    elif hook_type == "SessionStart":
        event_type = "session_start"
        summary = f"Session started in {project}" if project else "Session started"
        content = json.dumps(
            {
                "cwd": cwd,
                "entrypoint": entrypoint,
                "permission_mode": d.get("permission_mode", ""),
            }
        )

    elif hook_type == "SessionEnd":
        event_type = "session_end"
        summary = f"Session ended in {project}" if project else "Session ended"
        content = ""

    elif hook_type == "Notification":
        event_type = "notification"
        message = d.get("message", d.get("notification", d.get("tool_result", "")))
        if isinstance(message, dict):
            message = json.dumps(message)
        message = str(message)
        keywords = ["compact", "compress", "context reduced", "compaction", "context window"]
        if any(kw in message.lower() for kw in keywords):
            event_type = "compaction"
            summary = "Context compaction detected"
        else:
            summary = message[:200]
        content = message[:2000]

    else:
        event_type = hook_type.lower()
        summary = f"Hook event: {hook_type}"
        content = json.dumps(d)[:2000]

    return {
        "agent_id": session_id,
        "session_id": session_id,
        "event_type": event_type,
        "tool_name": tool_name,
        "summary": summary,
        "content": content,
        "files_affected": files,
        "agent_project": project,
        "agent_entrypoint": entrypoint,
        "agent_cwd": cwd,
    }


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return
    body = json.dumps(build_body(d))

    override = os.environ.get("MONITOR_URL")
    if override:
        # Explicit override — single target, parse host:port from the URL.
        # No /api/health pre-check: we just attempt the POST directly (see
        # agent-monitor-hook.py's header note in task-12-report.md for why).
        # Use HTTPS when the URL scheme says so (e.g. Cloudflare tunnels) so
        # the hooks_cloud example in claude-hooks-config.json keeps working —
        # plain HTTPConnection cannot speak TLS.
        from urllib.parse import urlparse

        u = urlparse(override)
        if u.hostname:
            use_https = u.scheme == "https"
            port = u.port or (443 if use_https else 80)
            try:
                def _post():
                    post_json(u.hostname, port, "/api/monitor/events", body, 5, use_https=use_https)
                post_bounded(_post, (), 6.0)
            except Exception:
                pass
        return

    for port in read_candidate_ports():
        # Post to EVERY listening instance — otherwise whichever instance is
        # open steals the events and the other's history has gaps. A refused
        # connection fails in ~1ms; only a listening-but-slow server costs time.
        try:
            post_json("127.0.0.1", port, "/api/monitor/events", body, 3)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
