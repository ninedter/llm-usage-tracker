# Edge shipper

Ships this machine's Claude Code / Codex activity to a remote LLM Usage Tracker
hub. It is the piece that makes the hub work for machines that aren't the hub:
Claude Code hooks post to a loopback intake here, the events land in a durable
on-disk spool, and a flusher forwards them in batches to
`POST ${TRACKER_URL}/api/ingest/v1` with a bearer token.

```
Claude Code hook ──POST 127.0.0.1:3799──▶ edge ──spool (JSONL, survives reboot)
                                            │
                                            └──POST /api/ingest/v1 (Bearer)──▶ hub
                                               batches ≤ 500 · retry w/ backoff
```

Why not have the hook post to the hub directly: hooks run in Claude Code's
critical path and must always exit 0 fast, so they can't wait on a tailnet that
might be down; and without a spool, every hook event fired while the hub is
unreachable is simply lost. The hub also *requires* a stable `source_id` per
event, which the edge derives and stores once, so retries are idempotent.

**v1 platforms: macOS and Linux.** Windows is roadmap — the code itself is
path-portable (`os.homedir()` everywhere, no Keychain), but no service
installer is provided yet.

## Requirements

Node ≥ 20. **No `npm install`** — the edge has zero dependencies and runs
straight from a checkout.

## Install — macOS (`henrymacbook-pro`, or the mini's own usage)

```bash
git clone https://github.com/ninedter/llm-usage-tracker.git ~/src/llm-usage-tracker

mkdir -p ~/.config/llm-usage-tracker-edge
cat > ~/.config/llm-usage-tracker-edge/.env <<'EOF'
TRACKER_URL=http://henrys-mac-mini:3789
MACHINE_ID=henrymacbook-pro
MACHINE_LABEL=Henry's MacBook Pro
EOF

# Append the hub's token without it reaching your shell history:
read -rs -p "INGEST_TOKEN: " T && printf 'INGEST_TOKEN=%s\n' "$T" >> ~/.config/llm-usage-tracker-edge/.env && unset T
chmod 600 ~/.config/llm-usage-tracker-edge/.env

node ~/src/llm-usage-tracker/edge/bin/llm-edge.js start
```

Then wire the hooks (below) and check `llm-edge status`.

Run it at login with launchd — `~/Library/LaunchAgents/com.llmusage.edge.plist`
(use the absolute path to your Node; `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.llmusage.edge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/src/llm-usage-tracker/edge/bin/llm-edge.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/llm-edge.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/llm-edge.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.llmusage.edge.plist
```

The token stays in `~/.config/llm-usage-tracker-edge/.env`, not in the plist.

## Install — Linux (`grok-bot-box`)

```bash
git clone https://github.com/ninedter/llm-usage-tracker.git ~/src/llm-usage-tracker

mkdir -p ~/.config/llm-usage-tracker-edge
cat > ~/.config/llm-usage-tracker-edge/.env <<'EOF'
TRACKER_URL=http://henrys-mac-mini:3789
MACHINE_ID=grok-bot-box
MACHINE_LABEL=Grok Bot box
EOF

read -rs -p "INGEST_TOKEN: " T && printf 'INGEST_TOKEN=%s\n' "$T" >> ~/.config/llm-usage-tracker-edge/.env && unset T
chmod 600 ~/.config/llm-usage-tracker-edge/.env

node ~/src/llm-usage-tracker/edge/bin/llm-edge.js start
```

As a user service — `~/.config/systemd/user/llm-edge.service`:

```ini
[Unit]
Description=LLM Usage Tracker edge shipper
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/src/llm-usage-tracker/edge/bin/llm-edge.js start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now llm-edge
loginctl enable-linger "$USER"   # keep it running when you're not logged in
journalctl --user -u llm-edge -f
```

`XDG_CONFIG_HOME` is honoured if you set it; otherwise config and spool live in
`~/.config/llm-usage-tracker-edge/` on both platforms.

## Wire the Claude Code hooks

Point the hooks at the edge instead of at a local tracker. `hooks/edge-hook.sh`
is a two-line wrapper around the existing `agent-monitor-hook.sh` — same
payload, same single process per event, different destination:

```json
{
  "hooks": {
    "PreToolUse":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=PreToolUse '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "PostToolUse":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=PostToolUse '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=Stop '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=SubagentStop '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=SessionStart '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "SessionEnd":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=SessionEnd '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "CLAUDE_HOOK_TYPE=Notification '/path/to/llm-usage-tracker/hooks/edge-hook.sh'" }] }]
  }
}
```

The same block is in `hooks/claude-hooks-config.json` as `hooks_edge`, ready to
copy. Under the hood it sets `MONITOR_URL=http://127.0.0.1:3799`, so the intake
also accepts `POST /api/monitor/events` verbatim — an existing hook config only
needs that one environment variable to start shipping through the edge.

Smoke-test all seven event types into the edge:

```bash
MONITOR_URL=http://127.0.0.1:3799 bash hooks/test-hook.sh
llm-edge status        # queued should have gone up (or shipped_total, if the hub is up)
```

Nothing here replaces `hooks_local`: a machine that runs the hub *and* its own
watchers on one box can keep posting to `/api/monitor/events` on the hub as
before.

## Configuration

Environment first, then `~/.config/llm-usage-tracker-edge/.env`, then
`config.json` in the same directory. Environment always wins, so a service unit
or a one-off export beats a stale file.

| Key | Default | Purpose |
|-----|---------|---------|
| `MACHINE_ID` | *(required)* | Stable id for this machine — `grok-bot-box`, `henrymacbook-pro`, `henrys-mac-mini`. Same charset as the hub: `[A-Za-z0-9._:-]`, ≤ 128 chars. |
| `INGEST_TOKEN` | *(required)* | Shared bearer token, must match the hub's. Never logged, never printed by any command. |
| `TRACKER_URL` | `http://henrys-mac-mini:3789` | Hub base URL. HTTP over Tailscale; the tailnet is the transport security. |
| `MACHINE_LABEL` | *(none)* | Display name in the hub UI. |
| `INTAKE_HOST` / `INTAKE_PORT` | `127.0.0.1` / `3799` | Loopback intake the hooks post to. |
| `FLUSH_INTERVAL_MS` | `5000` | Idle poll of the spool. A new event also triggers a flush ~250 ms later. |
| `MAX_BATCH_SIZE` | `500` | Events per request. Clamped to the hub's cap of 500. |
| `MAX_QUEUE_EVENTS` | `100000` | Spool cap. Past it the *oldest* events are dropped, with a warning. |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `2000` / `300000` | Exponential backoff with ±20% jitter while the hub is unreachable. |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout to the hub. |
| `EDGE_CONFIG_DIR` / `EDGE_DATA_DIR` | `~/.config/llm-usage-tracker-edge` | Config / spool location. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

## CLI

```bash
llm-edge start              # intake + flusher, foreground (what the service runs)
llm-edge status             # queue depth, hub URL, effective config (token redacted)
llm-edge drain              # ship everything queued right now, then exit
llm-edge send               # enqueue a synthetic event (--type <event_type>)
llm-edge send --dry-run     # print the exact JSON that would be POSTed to the hub
llm-edge config             # effective config, secrets redacted
```

Either add `edge/bin/llm-edge.js` to your `PATH` or run
`node /path/to/llm-usage-tracker/edge/bin/llm-edge.js <command>`. `status`,
`drain` and `send` talk to a running edge over the intake port when there is
one, and fall back to the spool on disk when there isn't — so `llm-edge drain`
also works as a cron-style one-shot shipper.

## Behaviour worth knowing

- **Durability.** Intake appends to `spool/queue.jsonl` before it answers the
  hook. A crash or reboot loses nothing that was acknowledged.
- **Idempotency.** Every event carries a `source_id`: the caller's if it sends
  one, otherwise a SHA-256 of the event's content *and* its millisecond
  timestamp. Retries and replayed batches are counted as duplicates by the hub
  and never inserted twice.
- **Batching.** Up to 500 events per request (the hub's `MAX_BATCH_SIZE`), each
  batch acknowledged before the next is sent.
- **Failure handling.** `401`/`403` — stop and say the token is wrong, keeping
  everything queued. `503` (hub started without `INGEST_TOKEN`) and any 5xx or
  network error — keep everything, back off. `400` — the batch is unshippable,
  so it is dropped with a logged reason rather than blocking every later event.
- **Secrets.** The token is only ever placed in an `Authorization` header. Every
  log line goes through a redactor that strips the literal token plus anything
  bearer- or token-shaped, and `status`/`config`/`/status` report only
  `***set***` or `***missing***`.
- **Intake is loopback-only** and unauthenticated by design: anything that can
  reach `127.0.0.1:3799` can already run the hook.

## Tests

```bash
cd edge && npm test        # node --test, no dependencies to install
```

Covers queue idempotency and durability, oldest-first eviction, batch chunking
at the hub's cap, the auth header and exact body shape, offline retry, backoff
bounds, config precedence, CLI behaviour, and that no log path can emit the
token. The hub side of the contract — an edge-built batch posted through the
real ingest route — is asserted in
`src/app/api/__tests__/edge-contract.test.ts` (`npm test` at the repo root).

## Troubleshooting

| Symptom | What it means |
|---------|---------------|
| `config: MACHINE_ID is required` | No `MACHINE_ID` in env or config file. |
| `intake port 3799 is already in use` | An edge is already running (or something else took the port; set `INTAKE_PORT`). |
| `hub rejected the ingest token` | `INGEST_TOKEN` here doesn't match the hub's. |
| `hub unreachable or erroring` with `status: 0` | Network/Tailscale — events keep queueing, nothing is lost. |
| `status: 503` from the hub | The hub itself was started without `INGEST_TOKEN`. |
| Queue grows, hooks look fine | Check `llm-edge status` for the hub URL, then `curl -sf $TRACKER_URL/api/health`. |
