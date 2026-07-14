# Multi-Provider Usage Tracking — Design

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan

## 1. Goal

Give the OpenAI/Codex side the same depth of tracked metrics the Claude side has, and bring the Claude side up to full parity (real token/model data it currently lacks). Both providers' activity — sessions, agents, tool calls, token usage, per-model breakdown, per-project activity — flows into the existing Analytics and Agent Monitor views, distinguished by **provider** (Claude / OpenAI) and **entrypoint** (Desktop / CLI / VS Code / SDK).

Additionally: move the Agent Monitor to its own full-width page (it's squeezed on the dashboard at low resolution), and put a compact live-usage strip for both providers at the top of that page.

## 2. Current State

- Agent Monitor + Analytics are fed **only** by Claude Code hooks (`hooks/agent-monitor-hook.sh` → `POST /api/monitor/events` → SQLite). Hooks capture events/agents/sessions but **not token usage**, so every cost/token column reads `$0` / `0`.
- OpenAI has no activity tracking at all — only the dashboard rate-limit card (`/api/usage/openai` via `~/.codex/auth.json` + `wham/usage`).
- Every session shows entrypoint "Desktop" because the user runs Claude via Claude Desktop and no other source is ingested.
- Dashboard (`src/app/page.tsx`) hosts the usage cards **and** the Agent Monitor panel in one viewport-capped row → the monitor is cramped at low resolution.

## 3. Data Sources (verified)

Both providers write rich per-session JSONL files locally:

### Claude — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (1,078 files)
- Per-entry top-level keys: `sessionId`, `cwd`, `gitBranch`, `entrypoint`, `version`, `isSidechain`, `parentUuid`, `userType`, `timestamp`, `type`, attribution fields (`attributionMcpServer/Tool/Plugin/Skill`).
- `type: "assistant"` entries carry `message.model` and `message.usage`:
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (per-turn — **sum across turns**).
- Tool calls: `message.content[]` blocks with `type: "tool_use"` (name + input); results arrive as `type: "user"` entries with `toolUseResult`.
- Subagents: `isSidechain: true` entries, linked via `parentUuid`.
- Entrypoint observed: `claude-desktop` (field mirrors Codex's originator; would show `cli`/`vscode` if used).
- Models observed: `claude-fable-5`, `claude-opus-4-8`.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl` (62 files)
- `type: "session_meta"`: `session_id`, `cwd`, `originator`, `source`, `cli_version`, `model_provider`, model.
- `type: "event_msg", payload.type: "token_count"`: `info.total_token_usage` (**cumulative** — take the last/max, do not sum) with `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`; plus a `rate_limits` snapshot.
- Tool activity: `response_item` `function_call` / `custom_tool_call` (+ `_output`), `event_msg` `mcp_tool_call_end`, `patch_apply_end` (file edits), `web_search_end`.
- Subagents: `event_msg` `sub_agent_activity`.
- Lifecycle: `task_started`, `task_complete`, `context_compacted` / `compacted`.
- Originator/source observed: `codex_work_desktop`/`Codex Desktop` (source `vscode`), `codex_cli_rs` (`cli`), `codex_vscode` (`vscode`), `codex_sdk_ts` (`exec`).

**Key token difference:** Claude `usage` is per-turn (sum); Codex `total_token_usage` is cumulative (take last).

## 4. Architecture — Unified File-Based Ingestion

Replace the asymmetric "Claude-via-hooks, OpenAI-via-nothing" model with **one file-based ingestion pipeline serving both providers**. This is what delivers parity and simplifies the topology (no more hook dual-posting / port discovery).

```
~/.claude/projects/**/*.jsonl ─┐
                               ├─► [ingest module] ─► normalize ─► SQLite (provider-tagged) ─► SSE ─► UI
~/.codex/sessions/**/*.jsonl  ─┘
```

### 4.1 Module layout — `src/lib/ingest/`
- `types.ts` — normalized record shapes (`NormalizedSession`, `NormalizedAgent`, `NormalizedEvent`, `NormalizedTokenUsage`).
- `entrypoints.ts` — shared raw-source → `{ key, label }` mapping (see §5).
- `claude.ts` — parse one Claude transcript file → normalized records.
- `codex.ts` — parse one Codex rollout file → normalized records.
- `store.ts` — idempotent upsert of normalized records into SQLite (dedup by native `sessionId`) + SSE broadcast of new events.
- `watcher.ts` — **polling** scan loop + boot-time backfill; owns `ingest_state` offsets.
- `index.ts` — `startIngestion()` called once on server boot.

### 4.2 Watcher — polling, not inotify
Docker bind mounts do **not** reliably propagate host `inotify` events, so `fs.watch` is unreliable inside the container. Use a **polling scan** (default ~2s interval): for each candidate file, compare `(mtime, size)` against `ingest_state`; if grown, read only bytes after the stored offset, parse complete lines, ingest, advance the offset. Works identically in Electron and Docker.

- **Backfill on boot:** enumerate both source dirs, process newest-first, ingest from stored offset (0 if new). Runs in the background (does not block server start); throttled/yielding so first-run over 1,078 files doesn't peg the box. Stream-read line-by-line (never load a whole file — this session's transcript is large).
- **Incremental:** steady-state each tick reads only the tail of files that grew.
- **Idempotent:** offset + `sessionId` dedup make re-runs safe.

### 4.3 Normalization mapping

**Session** (both): native `sessionId` → `sessions.id`; `provider`; `project` = `basename(cwd)`; `cwd`; `entrypoint` (mapped key); `started_at`/`updated_at`/`ended_at` from first/last timestamps; status from lifecycle (`active` while file is the newest & recently modified, else `completed`).

**Agents:** main chain (Claude `isSidechain:false` / Codex session) → one `main` agent per session; Claude `isSidechain:true` (grouped by `parentUuid`) and Codex `sub_agent_activity` → `subagent` agents.

**Events → `agent_events`:**
| Source event | Normalized `event_type` |
|---|---|
| Claude `tool_use` block / Codex `function_call`,`custom_tool_call`,`mcp_tool_call_end` | `tool_call` |
| Claude `toolUseResult` / Codex `*_output` | `tool_result` |
| Codex `patch_apply_end` / Claude Edit·Write tool | `tool_call` (+ `files_affected`) |
| Claude sidechain start / Codex `sub_agent_activity` | `subagent_start` / `subagent_stop` |
| Codex `context_compacted` / Claude compaction | `compaction` |
| lifecycle start/end | `session_start` / `session_end` / `stop` |

**Token usage → `token_usage`** (keyed by `session_id` + `model`):
- Claude: **sum** per-turn `message.usage` → `input_tokens`, `output_tokens`, `cache_read_tokens` (=`cache_read_input_tokens`), `cache_write_tokens` (=`cache_creation_input_tokens`).
- Codex: **last** `total_token_usage` → `input_tokens`, `output_tokens` (+ `reasoning_output_tokens` folded into output), `cache_read_tokens` (=`cached_input_tokens`), `cache_write_tokens` = 0.
- `cost` = 0 for both (subscriptions — see §8).

**Privacy:** store **metadata only** — tool names, token counts, timestamps, file basenames, short derived summaries. Never persist message text or reasoning content.

## 5. Entrypoint Mapping (`entrypoints.ts`)

Each real entrypoint labeled distinctly (per approved decision):

| Provider | raw originator / entrypoint | key | label |
|---|---|---|---|
| Claude | `claude-desktop` | `claude-desktop` | Claude Desktop |
| Claude | `cli` | `claude-cli` | Claude CLI |
| Claude | `vscode` (+ ide variants) | `claude-vscode` | Claude (VS Code) |
| OpenAI | `codex_work_desktop`, `Codex Desktop` | `codex-desktop` | Codex Desktop |
| OpenAI | `codex_cli_rs` | `codex-cli` | Codex CLI |
| OpenAI | `codex_vscode` | `codex-vscode` | Codex (VS Code) |
| OpenAI | `codex_sdk_ts` | `codex-sdk` | Codex (SDK) |

Unknown values fall back to a titlecased form of the raw string. Replaces the current ad-hoc `Desktop/Terminal/Agent` logic in the monitor + analytics.

## 6. Data Model Changes (`src/lib/db.ts`)

- `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'` (idempotent migration guard); same for `agents`, `agent_events`.
- New `ingest_state(source_path TEXT PRIMARY KEY, session_id TEXT, byte_offset INTEGER, mtime INTEGER, size INTEGER, updated_at INTEGER)`.
- Upserts: `INSERT ... ON CONFLICT(id) DO UPDATE` so backfill enriches existing hook-created rows (dedup by `sessionId`) rather than duplicating.
- Existing hook rows keep `provider='claude'`; backfill fills their missing `token_usage`.

## 7. UI Changes

### 7.1 Agent Monitor → its own page
- Promote `/monitor` to host the full `AgentMonitorPanel` **full-width** (fixes the low-res squeeze). Add **Monitor** to the top nav: Dashboard / Monitor / Analytics / Settings.
- Remove `AgentMonitorPanel` from `src/app/page.tsx`; the **Dashboard keeps the two detailed usage cards** (Claude left / OpenAI right).

### 7.2 Live-usage strip (top of Monitor page) — `ProviderUsageStrip`
- Compact two-provider bars (label + %), reusing `useClaudeUsage` / `useOpenAIUsage`.
- Shows each provider's **shortest reset window, computed dynamically** via `shortestWindow(provider, data)` = `min` by window length. Claude → 5h; OpenAI → 7d today, but auto-follows if OpenAI's primary window becomes 5h. Represent Claude's session(5h)/weekly(7d) with explicit `windowSeconds` so the same `min` logic works. **Nothing hardcoded.**

### 7.3 Provider filter + labels (Monitor + Analytics)
- **All / Claude / OpenAI** toggle. Monitor filters client-side on loaded data; Analytics passes a `provider` query param.
- Provider badge pill on session/agent rows (colors from `PROVIDER_INFO`); real entrypoint label from §5. Every existing panel (insights heatmap, tools, files, models, sessions, trend) works unchanged, just filtered.

### 7.4 Analytics API (`src/app/api/analytics/*` + `db.ts` queries)
- Add optional `provider` param to overview, trends, sessions, tools, files, models, insights → `WHERE provider = ?` (omitted = all).

## 8. Cost Handling

Both Claude (Max) and OpenAI (ChatGPT) here are **subscriptions**, not per-token billing. Do **not** fabricate dollar costs; show real **token counts + activity**. `cost = 0`, and the analytics already falls back to activity metrics (events/tools) when cost is absent. Consistent with today's `$0`.

## 9. Hook Retirement / Compatibility

File ingestion becomes the single source of truth. The installed Claude hook is no longer needed; keep `POST /api/monitor/events` as a **deprecated no-op that returns success** so the installed hook doesn't error. No user action required. (Hook removal from `~/.claude/settings.json` is optional, out of scope.)

## 10. Docker

Add a read-only mount of `~/.claude` to `docker-compose.yml` (mirroring the existing `~/.codex` mount) and expose it via an env var (e.g. `CLAUDE_HOME`), so the containerized watcher can read Claude transcripts. Each instance watches the files independently — the old hook dual-post is gone.

## 11. Testing

- **Unit (parsers):** fixtures for a Claude transcript snippet and a Codex rollout snippet → assert normalized sessions/agents/events and token totals; verify Claude **sum** vs Codex **cumulative-last** token logic; entrypoint mapping; subagent detection.
- **Unit (`shortestWindow`):** Claude→5h; OpenAI(7d only)→7d; OpenAI with an added 5h window→5h.
- **Unit (idempotency):** re-ingesting the same file (same offset) is a no-op; dedup by `sessionId` updates, not duplicates.
- **Integration:** backfill a temp fixture dir → assert provider row counts; append to a fixture file → assert incremental ingest + SSE broadcast.

## 12. Build / Deploy Notes

- Migration runs on DB open (idempotent `ADD COLUMN` guarded by pragma check).
- `docker compose up -d --build` picks up the new mount; verify on `:3789` (populated DB). Dev DB (`.data`) is empty.
- Respect the `better-sqlite3` dual-ABI dance: `npm rebuild better-sqlite3` for `next dev`, `npm run electron:rebuild-for-build` to restore for Electron/standalone.

## 13. Risks / Mitigations

- **First-run backfill cost** (1,078 files): background, newest-first, offset-tracked, streaming reads.
- **Docker bind-mount events:** solved by polling (not inotify).
- **Token attribution** (subagent vs main): attribute `usage` to the emitting chain via `isSidechain`/`parentUuid`.
- **Large transcripts:** line-streamed, never fully buffered.
- **Real-time latency:** file flush is per-message (seconds), slightly coarser than per-tool hooks — acceptable for an activity monitor; tool granularity is still present via tool-use blocks.

## 14. Out of Scope

- Per-token dollar cost estimation.
- Removing the hook from `~/.claude/settings.json`.
- Historical rate-limit trend charts from Codex `rate_limits` snapshots (possible future extension).
