# Docker Deployment — Design

**Date:** 2026-07-13
**Status:** Implemented (autonomous session — review welcome)

## Goal

Run the tracker continuously in a Docker container so usage is monitored live
without keeping the Electron app open. The Electron app remains usable; Docker is
an alternative runtime for the same Next.js standalone server.

## Approach

The Electron shell already just wraps a Next.js standalone server. The container
runs that server headless (`node server.js`), accessed from a browser at
`http://localhost:3789`. Electron-specific code never runs in the container.

Alternatives considered:

1. **Containerize the standalone server (chosen)** — smallest image, no display
   server needed, reuses the existing build pipeline (`next build` with
   `output: "standalone"` + postbuild static copy).
2. **launchd agent running `next start` on the host** — also "continuous", but the
   user asked for Docker specifically, and Docker Desktop is already running here.

## Key container decisions

- **Ports:** host `3789` → container `3000`. Chosen because 3000/3001/5050/5432/8080
  are occupied by other compose stacks on this machine and 3789 was free.
- **Persistence:** `LLM_DATA_DIR=/data`, bind-mounted to `./.docker-data`
  (gitignored). Holds `agent-monitor.db` (SQLite WAL — single writer, so a macOS
  bind mount is safe) and `credentials.enc.json`, seeded from the repo copy so the
  Claude session key works immediately.
- **Encryption key:** `credentials.ts` only reads `process.env.ENCRYPTION_KEY`
  (it never re-reads the `.env.local` it writes), and Next standalone does not load
  dotenv files — so compose passes the key via `env_file: .env.local` (the repo file
  already holds exactly this one variable). Without this, every container restart
  would regenerate the key and silently orphan stored credentials.
- **Claude usage in-container:** `readClaudeCodeOAuthToken()` is Keychain/darwin-only
  and returns null on Linux, so the client falls back to the claude.ai session-key
  path — which is why the seeded `credentials.enc.json` matters.
- **OpenAI usage in-container:** `~/.codex` is mounted read-only at `/codex` and
  `openai-client.ts` now honors `CODEX_HOME` (Codex CLI's own convention) before
  `~/.codex`. The *directory* is mounted rather than just `auth.json` because Docker
  single-file bind mounts go stale when the host tool replaces the file (rename-on-
  refresh), and Codex CLI refreshes tokens this way. Mount is read-only; the app
  never writes there.
- **Image:** multi-stage `node:22-bookworm-slim`. Builder runs `npm ci` with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (Electron is a devDependency; its ~100MB binary
  is useless in the image). Runner copies `.next/standalone` only and runs as the
  `node` user. `better-sqlite3` installs its Linux prebuild during the in-container
  `npm ci`, which sidesteps the Electron-vs-Node ABI gotcha from CLAUDE.md entirely.
- **Secrets hygiene:** `.dockerignore` excludes `credentials.enc.json` and `.env*`
  so secrets are never baked into image layers; they reach the container only via
  runtime mounts/env.
- **Continuity:** `restart: unless-stopped`.

## Claude Code hooks → container

`agent-monitor-hook.sh` previously found the server via the Electron port file
(`~/Library/Application Support/llm-usage-tracker/server-port`) and died silently
when that port wasn't listening (stale file after Electron quits). It now probes
candidates in order — `MONITOR_URL` override, port-file port, then `3789` — and
posts to the first one that answers. Electron keeps priority when it's running;
the container catches events the rest of the time.

## Verification

`docker compose up -d --build`, then: `/api/health` shows both providers connected
from inside the container; `/api/usage/claude` + `/api/usage/openai` return live
data on :3789; a hook-shaped POST to `/api/monitor/events` lands in SQLite on the
volume; `docker restart` preserves data and credentials (key stability); dashboard
renders in a browser.
