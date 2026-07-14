# Codex / OpenAI Monitor Ingestion — Design

- **Date:** 2026-07-14
- **Branch:** `feat/multi-provider-tracking`
- **Status:** Approved design, pending spec review

## Problem

The agent monitor and analytics are fed entirely by Claude Code hooks
(`hooks/agent-monitor-hook.sh` → `POST /api/monitor/events`). OpenAI's only
presence in the app is the dashboard **quota card** (`/api/usage/openai`), which
reads rate-limit windows from ChatGPT's `wham/usage` endpoint — percentages and
reset clocks only, no per-session tool calls, events, tokens, or files.

Codex CLI, however, writes full per-session transcripts to
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. These contain structured tool
calls, file patches, MCP calls, web searches, token counts, and subagent
metadata — enough to reconstruct the same tool-call/event/file/token breakdown
we already show for Claude.

This feature ingests those rollout logs into the existing
`sessions`/`agents`/`agent_events`/`token_usage` tables so the Monitor and every
Analytics panel work for OpenAI, with a provider filter to compare the two side
by side.

## Goals

- Full parity: Codex sessions appear in the **live Monitor** (near-real-time)
  **and** in **historical Analytics** (Tools, Files, Models, Insights, Trends,
  Sessions, Overview).
- A **provider dimension** (`openai` vs `anthropic`) with an
  All / Anthropic / OpenAI toggle across the Monitor and Analytics.
- Real **token** data for Codex (input / cached / output), **no fabricated
  dollar cost** — Codex runs on a flat ChatGPT subscription, not per-token
  billing.
- One-time **backfill of the last 90 days** of rollout history, then ongoing
  live tailing.
- Reuse the existing DB, analytics queries, and SSE broadcast — no rewrite.

## Non-goals

- No dollar-cost estimation for Codex (deliberately `cost = 0`).
- No capture of Codex `agent_reasoning` / `agent_message` / `user_message` text
  (Claude side doesn't log these either — parity).
- No changes to the existing Claude hook pipeline.
- No use of Codex's `notify` hook (too coarse — fires on turn complete only, not
  per tool call).
- Not touching the OpenAI quota card (it already works, live).

## Decisions (resolved during brainstorming)

1. **Scope:** Both live real-time streaming **and** historical backfill, in one
   build ("full parity now").
2. **Provider split:** Add a `provider` dimension and a filter/segmentation
   toggle across Monitor + Analytics (not just a passive label).
3. **Tokens/cost:** Populate real token counts; leave `cost = 0` (no fabricated
   or "API-equivalent" dollars). *Note: the Claude side's `token_usage` is
   currently empty because the hooks don't capture tokens, so this data is
   initially richer for OpenAI than Claude — an acceptable asymmetry.*
4. **Backfill depth:** Last 90 days only (aligns with the `daily_usage` 92-day
   analytics cap).

## Architecture (Approach A: in-process polling tailer + pure mapper)

Four new units, plus additive schema/query/UI changes. No existing module is
rewritten.

| Module | Responsibility | Depends on |
|---|---|---|
| `src/lib/providers/codex-rollout.ts` | **Pure mapper.** Rollout JSONL records → normalized `{session, agent, events[], tokenUsage}`. No I/O; unit-testable. | `@/types` |
| `src/lib/providers/codex-ingest.ts` | **Idempotent writer.** Persists mapped output with **real historical timestamps** + dedup; maintains a per-file byte cursor. | `db.ts`, mapper |
| `src/lib/providers/codex-watcher.ts` | **Backfill + poll loop.** On boot: import last 90 days; then every ~4s read new bytes per rollout file, ingest, and `broadcastEvent`. | ingest, `ws.ts` |
| `instrumentation.ts` (Next.js `register()`) | Starts the watcher once on server startup (works under both Electron and Docker). | watcher |

### Why polling, not `fs.watch`

`fs.watch`/chokidar is unreliable on Docker bind-mounts of macOS host
directories (and varies cross-platform), so it would need a polling fallback
regardless. A polling tailer is the single robust code path for both the
Electron (`.data`) and Docker (`.docker-data`) runtimes. The loop only `stat`s
mtimes and reads appended bytes via a per-file cursor, so idle cost is minimal.
`fs.watch` may be added later purely as a latency optimization.

### Rejected alternatives

- **B — Codex `notify` hook bridge** (a script Codex calls, POSTing to
  `/api/monitor/events`, mirroring the Claude hook). Rejected: `notify` fires
  only on turn-complete/notification, not per tool call, so it structurally
  cannot capture tool/file granularity — rollout parsing is required anyway.
  Also the events endpoint stamps `Date.now()`, unusable for historical
  timestamps.
- **C — `fs.watch`/chokidar event-driven watcher.** Rejected as the primary
  mechanism for the Docker bind-mount reliability reason above.

## Event mapping (Codex → existing event vocabulary)

The mapper reads **both** record streams in each rollout file — top-level
`event_msg` records and `response_item` records — and normalizes to the same
`event_type` / `tool_name` vocabulary the Claude hooks emit, so existing
analytics queries work unchanged.

| Codex rollout record | `event_type` | `tool_name` | Feeds |
|---|---|---|---|
| `session_meta` (root thread) | `session_start` | — | Sessions, Insights |
| `response_item.custom_tool_call` name=`exec` (+ `custom_tool_call_output`) | `tool_call` + `tool_result` | `exec` | Tools panel, success rate |
| `event_msg.patch_apply_end` | `tool_call` + `tool_result` | `apply_patch` | **Files panel** (paths = keys of `changes`), Explore/Modify mix |
| `event_msg.mcp_tool_call_end` | `tool_call` + `tool_result` | `mcp__{server}__{tool}` | Tools panel; duration from `duration`, success from `result.isError` |
| `event_msg.web_search_end` | `tool_call` | `web_search` | Tools panel |
| `event_msg.token_count` (final `total_token_usage`) | — (writes `token_usage`) | — | **Models panel**, token trends |
| `event_msg.context_compacted` | `compaction` | — | Activity feed |
| `event_msg.task_complete` | `stop` | — | Agent idle transitions (one per turn) |
| File idle past threshold (staleness) | `session_end` | — | Session duration |

### Session lifecycle / `ended_at`

Rollout files have no explicit "session over" record, so `session_end` is not
emitted from a line. Instead, during backfill a file whose last line predates
the poll window is closed immediately; during live tailing a session's
`ended_at` stays **NULL** until its rollout file has been idle beyond a
threshold, at which point the watcher marks it `completed` (reusing the existing
stale-session approach — cf. `abandonStaleSessions`, 5-min idle). Until then,
analytics already clamp a NULL `ended_at` to the last observed event
(`getUsageInsights` / `getSessionAnalytics`), so open Codex sessions report
correct durations without a synthetic end.

### Deliberately skipped (parity with Claude, which does not log these)

- `event_msg.agent_reasoning` (~1400/session — reasoning text)
- `event_msg.agent_message`, `event_msg.user_message`
- `event_msg.sub_agent_activity` kind=`interacted` (~400/session progress pings)
  and `thread_settings_applied`
- `response_item.message` / `response_item.reasoning`

### Naming

Native Codex tool names are kept (`exec`, `apply_patch`, `web_search`,
`mcp__server__tool`) rather than renamed to Claude equivalents (`Bash`, `Edit`,
…). With the provider filter this enables honest comparison
("Codex `exec` vs Claude `Bash`") without silently merging distinct tools.

### Subagents

Codex writes **each thread as its own rollout file**. `session_meta` carries
`thread_source` (`subagent` vs root), `parent_thread_id`, `forked_from_id`, and
`source.subagent` (with `depth`, `agent_path`, `agent_nickname`). The mapper:

- Root thread (`thread_source != 'subagent'`) → a `sessions` row + `type='main'`
  agent.
- Subagent thread → `type='subagent'` agent with `parent_agent_id =
  codex:{parent_thread_id}`, grouped under the root ancestor's session.

This reconstructs the nested tree the Claude Monitor already shows, using
`session_meta` links instead of the noisy `sub_agent_activity` pings. Ordering
nuance for live: a subagent file may be tailed before its parent's
`session_meta` is seen; in that case the agent is created with its
`parent_agent_id` recorded and attaches to the parent session when the parent
appears (backfill processes the full graph up-front, so this only affects live).

### ID scheme

All Codex-derived ids are prefixed `codex:` (e.g. session id =
`codex:{thread_session_id}`) to guarantee no primary-key collision with Claude
UUIDs. The `provider` column is the semantic discriminator; the prefix is
belt-and-suspenders.

## Schema changes (additive migrations)

Follow the existing forward-migration pattern in `db.ts` (~line 105, `PRAGMA
table_info` + conditional `ALTER TABLE ADD COLUMN`).

1. `provider TEXT NOT NULL DEFAULT 'anthropic'` added to **`sessions`**,
   **`agent_events`**, and **`token_usage`**. Denormalized onto events and
   token_usage so every analytics query filters with a single `AND provider = ?`
   and no extra join. Existing rows default to `'anthropic'`. The write helpers
   `createSession`, `createEvent`, and `upsertTokenUsage` gain an optional
   `provider` argument defaulting to `'anthropic'`, so the existing Claude hook
   path is unchanged while `codex-ingest` passes `'openai'`.
2. `source_id TEXT` added to **`agent_events`**, plus a partial unique index
   `CREATE UNIQUE INDEX ... ON agent_events(source_id) WHERE source_id IS NOT
   NULL`. Codex events set `source_id` (derived from `call_id`, or
   `file+lineOffset` for records without one); ingest uses `INSERT OR IGNORE` so
   re-reading a file never duplicates. Claude events leave `source_id` NULL and
   are unaffected.

No existing columns change. `token_usage` already upserts on `(session_id,
model)`; `sessions` and `agents` already `INSERT OR IGNORE` — so those are
idempotent as-is. A new tiny table tracks tail cursors:

```sql
CREATE TABLE IF NOT EXISTS codex_ingest (
  file_path     TEXT PRIMARY KEY,
  byte_offset   INTEGER NOT NULL DEFAULT 0,
  thread_id     TEXT,
  last_seen_at  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'  -- active | done
);
```

## Provider filtering

- Each analytics function in `db.ts` (`getAnalyticsOverview`,
  `getAnalyticsTrends`, `getSessionAnalytics`, `getToolAnalytics`,
  `getFileAnalytics`, `getModelAnalytics`, `getUsageInsights`) gains an optional
  `provider?: 'openai' | 'anthropic'` argument that appends `AND provider = ?`
  (omitted = All). Denormalization means even queries that hit `agent_events`
  without a `sessions` join (tools, insights heatmap) filter directly.
- The six `/api/analytics/*` routes and the monitor routes
  (`agents`, `sessions`, `stats`, `stream`) read `?provider=` and pass it
  through.
- **UI:** an All / Anthropic / OpenAI segmented toggle in the Analytics header
  (beside `TimeRangePicker`) and in the Monitor panel. `use-analytics.ts` and
  `use-agent-monitor.ts` thread the param. Session rows and `AgentCard` render a
  small provider badge (Claude / OpenAI).

## Token usage

From each rollout, the **final** `token_count.info.total_token_usage` is the
session cumulative total. Map to a `token_usage` row:

- `input_tokens` ← `input_tokens`
- `output_tokens` ← `output_tokens`
- `cache_read_tokens` ← `cached_input_tokens`
- `cache_write_tokens` ← 0 (Codex doesn't report cache writes)
- `cost` ← 0 (subscription, not per-token)
- `model` ← from `session_meta` / `turn_context` (token_count records don't carry
  the model name)
- `session_id` ← the thread's session id, `provider='openai'`

## Live path, error handling, testing

**Live tailing.** The poll loop keeps an in-memory + persisted `{file →
byteOffset}` cursor. Each tick: find rollout files with mtime past the last
check, read only appended bytes, split on newlines, and process **complete**
lines only — a partial trailing line from an in-progress write is left for the
next tick. Mapped events are ingested and `broadcastEvent`-ed, so Codex agents
stream into the Monitor with a ~4s lag. Backfill and live share the same ingest
path (backfill = one pass from offset 0 over files within the 90-day window).

**Dual instances.** Each running server (Electron `.data`, Docker
`.docker-data`) tails `~/.codex` independently and writes its own DB —
consistent with today's dual-post hook behavior, but with no network hop.
`~/.codex` is only ever **read** (mounted read-only in Docker); cursor state
lives in the app DB, never written back to `~/.codex`.

**Error handling.**
- Malformed / non-JSON lines are skipped individually.
- Missing `~/.codex` (or `CODEX_HOME`) → watcher no-ops silently, mirroring
  `OpenAIClient.readCodexAuth()` returning null.
- Any watcher/parse error is caught and logged; it never crashes the server or
  blocks a request.
- Re-running backfill or re-reading a file is safe (idempotent via `source_id`
  + `INSERT OR IGNORE` and upserts).

**Testing.**
- Unit tests for the pure mapper: one fixture rollout line per record type
  asserting the normalized output (event_type, tool_name, files_affected,
  token totals, subagent linkage).
- Idempotency test: ingest a fixture file twice → zero duplicate `agent_events`.
- Provider-filter query test: seed anthropic + openai rows, assert each
  analytics function returns the correctly filtered subset and All returns both.

## Build order (for the implementation plan)

1. Schema: `provider` columns + migration/backfill, `source_id` + unique index,
   `codex_ingest` table.
2. `codex-rollout.ts` pure mapper + unit tests.
3. `codex-ingest.ts` idempotent writer (historical timestamps, dedup, cursor).
4. `codex-watcher.ts` + `instrumentation.ts` (backfill-then-tail).
5. Provider threading through `db.ts` analytics fns + `/api/analytics/*` and
   monitor routes.
6. UI: provider toggle (Analytics + Monitor) + provider badges; thread param
   through `use-analytics.ts` / `use-agent-monitor.ts`.

## Appendix — Codex rollout format reference (observed 2026-07-14)

Top-level record `type`s: `session_meta`, `response_item`, `event_msg`,
`compacted`, `world_state`, `turn_context`, `inter_agent_communication_metadata`.

Key `event_msg.payload.type` shapes:

- `token_count`: `info.total_token_usage.{input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens}`,
  `info.last_token_usage.{…}` (per-turn delta), `info.model_context_window`,
  `rate_limits.{primary,secondary}` (mirrors the quota card's data).
- `mcp_tool_call_end`: `call_id`, `invocation.{server, tool, arguments}`,
  `duration.{secs, nanos}`, `result.Ok.{content, isError}` or `result.Err`.
- `patch_apply_end`: `call_id`, `turn_id`, `stdout`, `stderr`, `success` (bool),
  `changes: { "<absolute file path>": { type: add|update|delete, content } }`.
- `web_search_end`: `call_id`, `query`, `action.queries[]`.
- `sub_agent_activity`: `event_id`, `occurred_at_ms`, `agent_thread_id`,
  `agent_path`, `kind` ∈ {`started`, `interacted`, `interrupted`}.
- `task_started` / `task_complete`: `turn_id`, `started_at`/`completed_at`,
  `duration_ms`, `time_to_first_token_ms`.
- `context_compacted`.

`response_item.payload.type` shapes:

- `custom_tool_call`: `id`, `status`, `call_id`, `name` (e.g. `exec`), `input`
  (string; the JS `tools.exec_command({cmd: …})` invocation),
  `internal_chat_message_metadata_passthrough` (contains `turn_id`).
- `custom_tool_call_output`: paired result for a `custom_tool_call`.
- `message`, `reasoning`, `agent_message` (skipped).

`session_meta.payload` fields: `session_id`, `id`, `forked_from_id`,
`parent_thread_id`, `timestamp` (ISO 8601), `cwd`, `originator`
(e.g. `codex_work_desktop`), `cli_version`, `source.subagent.thread_spawn.{
parent_thread_id, depth, agent_path, agent_nickname, agent_role}`,
`thread_source` (`subagent` vs root), `agent_nickname`, `agent_path`.

Project name is derived as `basename(cwd)` — the same rule the Claude hook uses
(`agent-monitor-hook.sh:71`). Entry point derived from `originator`
(e.g. `codex-desktop`).
