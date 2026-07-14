# Multi-Provider Usage Tracking Implementation Plan (v2 — aligned to committed spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
>
> **Authoritative design:** `docs/superpowers/specs/2026-07-14-codex-openai-monitor-ingestion-design.md` (the user's committed spec). This plan implements it. Where this plan is terse, that spec is the detail (esp. the event-mapping table §"Event mapping" and the format reference appendix). Two additions beyond that spec, both requested in chat / recommended: the Monitor-page relocation + live usage strip (Tasks 10-11), and a bounded Claude-transcript **token** backfill for parity (Task 12).

**Goal:** Ingest Codex rollout logs into the existing sessions/agents/events/token_usage tables so the Monitor and every Analytics panel work for OpenAI, add an All/Anthropic/OpenAI provider filter, relocate the Monitor to its own full-width page with a live dual-provider usage strip, and backfill Claude token data for parity.

**Architecture:** In-process polling tailer + pure mapper (spec Approach A). Additive schema. No existing module rewritten; **Claude hook pipeline untouched**.

**Tech Stack:** Next.js 15 App Router, React 19, TS strict, better-sqlite3 (sync), Tailwind 4, SWR, Vitest.

## Global Constraints

- `provider` values: exactly `'anthropic'` or `'openai'`. Existing rows + Claude hook path default to `'anthropic'`. (Note: `PROVIDER_INFO` in `constants.ts` keys these as `claude`/`openai` for display/color — map `'anthropic'`→`PROVIDER_INFO.claude`, label "Claude".)
- **Do not change the Claude hook pipeline** (`hooks/agent-monitor-hook.sh`, `POST /api/monitor/events`). Additive only.
- All Codex-derived IDs are `codex:`-prefixed (session id = `codex:{thread_session_id}`) to avoid PK collision with Claude UUIDs.
- Store metadata only — tool names, token counts, timestamps, file paths, short summaries. Skip Codex `agent_reasoning`/`agent_message`/`user_message`/`reasoning`/`message` and `sub_agent_activity kind=interacted` (spec "Deliberately skipped").
- `cost = 0` for Codex and for the Claude token backfill (subscriptions — no fabricated dollars).
- Keep **native Codex tool names** (`exec`, `apply_patch`, `web_search`, `mcp__{server}__{tool}`) — do not rename to Claude equivalents.
- Backfill depth: **last 90 days** (aligns with the `daily_usage` 92-day cap).
- Watcher uses **polling** (not `fs.watch`) — robust for Docker bind-mounts; `stat` mtime + read appended bytes via per-file cursor; process complete lines only.
- `~/.codex` (and `~/.claude` for Task 12) are **read-only**; cursor state lives in the app DB.
- Idempotent: re-reading a file never duplicates (Codex events via `source_id` + `INSERT OR IGNORE`; sessions/agents `INSERT OR IGNORE`; token_usage upsert on `(session_id, model)`).
- Missing `~/.codex`/`CODEX_HOME` → watcher no-ops silently. Malformed lines skipped individually. Watcher errors caught + logged, never crash the server.
- API routes return `{ success, data }` / `{ success, error:{code,message} }`. DB is synchronous.
- Respect the better-sqlite3 dual-ABI workflow: Node ABI for Vitest/`next dev` (currently active); `npm run electron:rebuild-for-build` restores Electron ABI for the standalone build; verify against Docker `:3789` (dev `.data` DB is empty).

---

## Task 1: Vitest setup — ✅ COMPLETE (commits 26c9b08, aade41c)

Vitest installed, `vitest.config.mts` (ESM, pristine output), `test`/`test:watch` scripts, smoke test passing. Do not redo.

---

# PHASE 1 — Codex ingestion

## Task 2: Schema — provider column, source_id, codex_ingest

**Files:** Modify `src/lib/db.ts` (migration block ~line 105; `db.exec` table block; write helpers `createSession`/`createEvent`/`upsertTokenUsage`); `src/types/index.ts` (add `provider` to `SessionRecord`/`AgentEvent`/`TokenUsage`, add `CodexIngestRow`). Test `src/lib/__tests__/schema.test.ts`.

**Interfaces (Produces):**
- `sessions`, `agent_events`, `token_usage` gain `provider TEXT NOT NULL DEFAULT 'anthropic'`.
- `agent_events` gains `source_id TEXT` + `CREATE UNIQUE INDEX ... ON agent_events(source_id) WHERE source_id IS NOT NULL`.
- `codex_ingest(file_path PK, byte_offset INT, thread_id TEXT, last_seen_at INT, status TEXT DEFAULT 'active')`.
- `createSession(session, provider='anthropic')`, `createEvent(event, provider='anthropic', sourceId=null)`, `upsertTokenUsage(usage, provider='anthropic')` — optional trailing args, existing callers unchanged.
- `getCodexIngest(filePath)`, `upsertCodexIngest(row)`.

- [ ] **Step 1:** Failing test — assert `provider` column exists on all three tables (default `'anthropic'`), `source_id` unique index rejects a duplicate non-null `source_id` but allows multiple NULLs, and `upsertCodexIngest`/`getCodexIngest` round-trip. Run: `npm test src/lib/__tests__/schema.test.ts` → FAIL.
- [ ] **Step 2:** Add the three tables/columns/index + `codex_ingest` table (follow the existing `PRAGMA table_info` conditional-`ALTER` pattern at db.ts:105). Add provider indexes `idx_events_provider`, `idx_sessions_provider`.
- [ ] **Step 3:** Extend `createSession`/`createEvent`/`upsertTokenUsage` with the optional `provider`/`sourceId` args (default `'anthropic'`/null); `createEvent` uses `INSERT OR IGNORE` when `sourceId` is set. Add `getCodexIngest`/`upsertCodexIngest`. Update the three types.
- [ ] **Step 4:** Run → PASS. **Step 5:** `git commit -am "feat(db): provider column, source_id dedup, codex_ingest cursor"`.

## Task 3: Codex rollout mapper (pure)

**Files:** Create `src/lib/providers/codex-rollout.ts`. Test `src/lib/providers/__tests__/codex-rollout.test.ts`.

**Interfaces (Produces):** `mapCodexRollout(lines: string[]): { session, mainAgent, subAgents, events, tokenUsage } | null` — pure, no I/O. Implements the spec's **Event mapping** table and **Subagents**/**ID scheme**/**Token usage** sections verbatim: `session_meta`→session (`codex:{session_id}`, project=`basename(cwd)`, entrypoint from `originator`, provider `openai`; subagent when `thread_source==='subagent'` → `type='subagent'`, `parent_agent_id=codex:{parent_thread_id}`); `custom_tool_call`(name `exec`)+`_output`→`tool_call`+`tool_result`; `patch_apply_end`→`tool_call`+`tool_result` name `apply_patch`, `files_affected`=keys of `changes`; `mcp_tool_call_end`→`mcp__{server}__{tool}` (success from `result` Ok/Err); `web_search_end`→`web_search`; `context_compacted`→`compaction`; `task_complete`→`stop`; final `token_count.info.total_token_usage`→token_usage (input, output, cacheRead=`cached_input_tokens`, cacheWrite=0). `source_id` from `call_id` (fallback `file+lineIndex`). Skip the spec's "Deliberately skipped" records.

- [ ] **Step 1:** Failing test — a fixture array with `session_meta` (root, `originator: "codex_cli_rs"`), a `custom_tool_call` name `exec` + output, a `patch_apply_end` with two `changes` paths, an `mcp_tool_call_end`, and two `token_count` records; assert: session id `codex:…`, entrypoint label "Codex CLI", tool events with correct names, `files_affected` has both paths, token_usage = **last** cumulative totals with cacheRead mapped. Run → FAIL.
- [ ] **Step 2:** Implement `mapCodexRollout` per the spec sections. Reuse the entrypoint mapping (originator→label): `codex_work_desktop`/`Codex Desktop`→"Codex Desktop", `codex_cli_rs`→"Codex CLI", `codex_vscode`→"Codex (VS Code)", `codex_sdk_ts`→"Codex (SDK)", else titlecase.
- [ ] **Step 3:** Run → PASS. **Step 4:** `git commit -am "feat(codex): pure rollout mapper"`.

## Task 4: Codex ingest writer (idempotent)

**Files:** Create `src/lib/providers/codex-ingest.ts`. Test `src/lib/providers/__tests__/codex-ingest.test.ts`.

**Interfaces (Produces):** `ingestCodexRollout(filePath: string, lines: string[]): void` — maps then persists with **real historical timestamps** (use the rollout's own timestamps, not `Date.now()`), provider `'openai'`, `source_id` dedup; updates the `codex_ingest` cursor. Depends on Task 2 helpers + Task 3 mapper. Subagent whose parent isn't present yet still persists with `parent_agent_id` recorded (attaches when parent appears — backfill processes full graph up-front).

- [ ] **Step 1:** Failing test — ingest a fixture file's lines **twice**; assert exactly one session row (provider `openai`), correct token_usage, and **zero duplicate** `agent_events` (source_id + INSERT OR IGNORE). Run → FAIL.
- [ ] **Step 2:** Implement using the mapper + `createSession`/`createAgent`/`createEvent(...,'openai',sourceId)`/`upsertTokenUsage(...,'openai')`, wrapped in one transaction; timestamps from the mapped records.
- [ ] **Step 3:** Run → PASS. **Step 4:** `git commit -am "feat(codex): idempotent ingest writer"`.

## Task 5: Codex watcher + boot

**Files:** Create `src/lib/providers/codex-watcher.ts`, `src/instrumentation.ts`. Test `src/lib/providers/__tests__/codex-watcher.test.ts`.

**Interfaces (Produces):** `ingestCodexFileOnce(filePath)` (read appended bytes past the `codex_ingest` byte cursor, complete lines only, call `ingestCodexRollout`, `broadcastEvent`, advance cursor); `startCodexWatcher(opts?)` — 90-day backfill (files under `CODEX_HOME`/`~/.codex/sessions` with mtime in window, newest-first, yield between files) then `setInterval` poll (~4s). `register()` in `instrumentation.ts` calls it when `NEXT_RUNTIME==='nodejs'`.

- [ ] **Step 1:** Failing test — write a temp rollout file, call `ingestCodexFileOnce`, assert the `codex:` session lands in the DB with provider `openai`. Run → FAIL.
- [ ] **Step 2:** Implement watcher (polling, cursor, broadcast, silent no-op if root missing) + `instrumentation.ts`.
- [ ] **Step 3:** Run → PASS. **Step 4 (manual, Docker):** `docker compose up -d --build`; after ~30s `curl -s localhost:3789/api/monitor/sessions | grep -c codex:` > 0. **Step 5:** `git commit -am "feat(codex): polling watcher + backfill + boot hook"`.

---

# PHASE 2 — Provider filtering

## Task 6: provider filter in db.ts analytics

**Files:** Modify `src/lib/db.ts` — optional `provider?: 'anthropic'|'openai'` on `getAnalyticsOverview`, `getAnalyticsTrends`, `getSessionAnalytics`, `getToolAnalytics`, `getFileAnalytics`, `getModelAnalytics`, `getUsageInsights`, `listSessions`, `listAgents`. Test `src/lib/__tests__/provider-filter.test.ts`.

**Interfaces:** each appends `AND provider = ?` (on `agent_events.provider` or `s.provider` as the query's table dictates — denormalized `provider` means tools/heatmap queries filter directly, no join); omitted = All.

- [ ] **Step 1:** Failing test — seed one `anthropic` + one `openai` session with a `tool_call` each; assert `getToolAnalytics(0, now, 'openai')` counts only openai, `'anthropic'` only anthropic, and undefined counts both. Run → FAIL.
- [ ] **Step 2:** Thread `provider` through every listed function via a `${pClause}`/`...pArgs` pattern on each sub-query. **Step 3:** Run → PASS. **Step 4:** `git commit -am "feat(db): provider filter on analytics"`.

## Task 7: provider param on routes + hooks

**Files:** Modify `src/app/api/analytics/{overview,trends,sessions,tools,files,models,insights}/route.ts`, `src/app/api/monitor/{agents,sessions,stats}/route.ts`; `src/hooks/use-analytics.ts`, `src/hooks/use-agent-monitor.ts`.

**Interfaces:** routes read `searchParams.get("provider")` → pass to the db fn; hooks thread a `provider` param into their SWR keys.

- [ ] **Step 1:** Add `provider` extraction to each route (one pattern, repeated). **Step 2:** Thread through the two hooks. **Step 3 (verify):** `curl "localhost:3789/api/analytics/tools?provider=openai"` vs `?provider=anthropic` differ. **Step 4:** `git commit -am "feat(api): provider query param"`.

---

# PHASE 3 — UI

## Task 8: provider toggle + badges

**Files:** Create `src/components/ui/ProviderBadge.tsx`; modify `src/components/monitor/AgentMonitorPanel.tsx` (All/Anthropic/OpenAI toggle, client-filter by `provider`; badge on SessionCard), `src/components/monitor/AgentCard.tsx` (badge), `src/app/analytics/page.tsx` (toggle beside TimeRangePicker), `src/hooks/use-analytics.ts` (provider state → param).

**Interfaces:** `<ProviderBadge provider={'anthropic'|'openai'} />` — pill, "Claude"/`#D4A574` or "OpenAI"/`#10A37F`, ≥12px.

- [ ] **Step 1:** `ProviderBadge`. **Step 2:** Monitor toggle + client filter + badges. **Step 3:** Analytics toggle + param thread. **Step 4 (verify Task 13).** **Step 5:** `git commit -am "feat(ui): provider toggle + badges"`.

## Task 9: shortestWindow helper + live strip

**Files:** Create `src/lib/usage/windows.ts` (+ test `src/lib/usage/__tests__/windows.test.ts`), `src/components/monitor/ProviderUsageStrip.tsx`.

**Interfaces:** `claudeShortestWindow(d)`→5h, `openaiShortestWindow(d)`→min-`windowSeconds` window (7d now, auto-follows if a 5h appears), `compactWindowLabel(s)`. `<ProviderUsageStrip/>` renders one compact bar per connected provider (name · window label · %), ≥12px, colors from `PROVIDER_INFO`.

- [ ] **Step 1:** Failing test for the three helpers (claude→"5h"; openai 7d-only→"7d"; openai with an added 18000s window→"5h"; `compactWindowLabel(18000)`="5h", `(604800)`="7d"). Run → FAIL. **Step 2:** Implement helpers (Claude candidates `session`=18000s / `weekly`=604800s, reduce to min; OpenAI reduce `windows`). Run → PASS. **Step 3:** `ProviderUsageStrip` using `useHealth`/`useClaudeUsage`/`useOpenAIUsage` + helpers. **Step 4:** `git commit -am "feat(monitor): dynamic shortest-window strip"`.

## Task 10: Agent Monitor → own page + strip + nav

**Files:** Modify `src/app/monitor/page.tsx` (host `<ProviderUsageStrip/>` + full-width `<AgentMonitorPanel/>`; keep `h-[calc(100vh-2rem)]`/`min-h-0 flex-1`), `src/app/page.tsx` (remove `AgentMonitorPanel`, keep `DashboardGrid`, add Monitor nav link), `src/app/analytics/page.tsx` (Monitor nav link).

- [ ] **Step 1:** Rebuild `monitor/page.tsx` (strip + full-width panel). **Step 2:** Trim dashboard to cards + Monitor link. **Step 3 (verify browser):** Monitor full-width, strip shows both providers' shortest window, dashboard cards only, no h-scroll at 1280 and narrow. **Step 4:** `git commit -am "feat(ui): Agent Monitor as its own full-width page"`.

---

# PHASE 4 — Claude token parity (bounded; hook untouched)

## Task 11: Claude transcript token backfill

**Files:** Create `src/lib/providers/claude-transcript.ts` (+ test), wire into a watcher (extend `codex-watcher.ts` or a sibling `claude-token-watcher.ts`) over `~/.claude/projects`; modify `docker-compose.yml` (mount `~/.claude:ro` + `CLAUDE_HOME`).

**Interfaces:** `mapClaudeTokens(lines): { sessionId, tokensByModel }` — sum per-turn `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`→cacheRead, `cache_creation_input_tokens`→cacheWrite) per `message.model`. Writer upserts **token_usage only** (provider `'anthropic'`, `cost:0`) keyed by the transcript's `sessionId` — **creates/touches no events/agents** (the hook owns those). Skips a session with no `sessionId`.

- [ ] **Step 1:** Failing test — fixture transcript with two `assistant` turns (same model); assert summed token_usage. Run → FAIL. **Step 2:** Implement mapper + token-only upsert writer + watcher wiring (90-day, polling, `CLAUDE_HOME`/`~/.claude`). **Step 3:** Run → PASS. **Step 4:** Docker mount. **Step 5:** `git commit -am "feat(claude): transcript token backfill (parity, hook untouched)"`.

---

# PHASE 5 — Verify

## Task 12: Build, deploy, verify

- [ ] **Step 1:** `npx tsc --noEmit` clean. **Step 2:** `npm run build && npm run electron:rebuild-for-build && ELECTRON_RUN_AS_NODE=1 npx electron -e "require('better-sqlite3')"`. **Step 3:** `docker compose up -d --build`, health OK. **Step 4 (browser :3789):** Monitor page full-width with strip (Claude 5h + OpenAI 7d); agents from both providers with badges + entrypoint labels; provider toggle filters Monitor + every Analytics tab; OpenAI sessions show real tokens; Claude sessions now show tokens/models too; min font 12px. **Step 5:** `git commit -am "chore: build + deploy multi-provider tracking"`.

---

## Self-Review (author)

- Covers committed spec: schema (T2), mapper (T3), ingest (T4), watcher+boot (T5), provider filter db+routes+hooks (T6/T7), UI toggle+badges (T8) — all per that spec, `provider='anthropic'`, `codex:` ids, `source_id` dedup, 90-day backfill, native tool names, hook untouched, cost=0. Chat additions: live strip (T9) + Monitor page move (T10). Recommendation: Claude token parity (T11), bounded to token_usage, hook untouched. Verify (T12).
- Type/name consistency: `provider` `'anthropic'|'openai'`; `mapCodexRollout`, `ingestCodexRollout`, `ingestCodexFileOnce`, `startCodexWatcher`, `mapClaudeTokens`, `claude/openaiShortestWindow`, `compactWindowLabel`, `getCodexIngest`/`upsertCodexIngest` used consistently.
