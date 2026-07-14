# Data Purge Mechanism — Design

**Date:** 2026-07-14
**Status:** Approved — ready for implementation planning

## Goal

Give the user a way, **from the Settings section**, to purge accumulated monitor data
so the SQLite database doesn't pile up unbounded. Two complementary controls:

1. **Manual purge** — a button that deletes data older than a chosen window (or
   everything), on demand.
2. **Automatic retention policy** — an optional "keep the last N days" setting that
   quietly purges older data about once a day while the tracker is running.

When a purge deletes raw data, it **first folds the deleted span into the `daily_usage`
summary** so long-term trend charts keep their history; `daily_usage` is never
auto-purged.

## Context / current state

- Data lives in **two** SQLite DBs, both served by the same Next.js server code:
  the Electron app's `.data/agent-monitor.db` and the canonical Docker instance's
  `.docker-data/agent-monitor.db` (~15 MB, the one actually piling up). A purge
  operates on whichever DB the serving process owns — so running it against the
  Docker instance (browse to `http://localhost:3789/settings`) purges the big DB,
  and running it in Electron purges `.data`. This is the correct, natural behavior;
  the design does not try to reach across instances.
- The bulk of the data is `agent_events` (17,683 rows of a ~15 MB DB, spanning
  2026-03-16 → today). `token_usage` and `daily_usage` are currently empty on this
  machine, but the design keeps them correct for the general case.
- **Building blocks that already exist** in `src/lib/db.ts`:
  - `deleteOldSessions(olderThanMs)` — deletes `sessions`/`agents`/`agent_events`/
    `token_usage` older than a cutoff and **leaves `daily_usage` intact**. Currently
    dead code (no route, no caller). This is the core of the manual/auto purge.
  - `clearAllMonitorData()` — nukes all four raw tables. Already wired to a trash
    icon on the **Monitor** page (`AgentMonitorPanel.tsx`), not Settings. Reused for
    the "Everything" window option.
  - `rollupDailyUsageRange(from, to)` — upserts `daily_usage` for a span. **Caps its
    scan to the most recent 92 days** (`minFrom = Math.max(from, to - 92 days)`).
  - `getMonitorStats()` — table counts used by the dashboard.
- **Maintenance pattern in this repo is request-piggybacked, not scheduled.**
  `GET /api/monitor/stats` calls `abandonStaleSessions()` + `archiveStaleAgents()` on
  every poll (~30s via SWR); event ingest and analytics routes call `rollupDailyUsage`.
  There is no `setInterval`/cron scheduler. The automatic retention policy follows
  this same pattern.
- API envelope convention: `{ success: true, data }` / `{ success: false, error: {
  code, message } }`. DB layer is synchronous (`better-sqlite3`). Real-time refresh
  via `broadcastEvent({ type: "stats_updated", data })` in `src/lib/ws.ts`.

## Approaches considered — how automatic retention executes

1. **Lazy request-piggyback (chosen).** The retention check rides the existing
   maintenance path in `GET /api/monitor/stats`. It reads a `last_purge_at` timestamp
   from a new `app_settings` table; if retention is enabled and >24h have elapsed, it
   runs the age-based purge once and updates the timestamp. Zero new infrastructure,
   behaves **identically in Electron and Docker** (both serve the same Next server),
   survives restarts (state is in the DB), and matches the repo's established
   "maintenance on request" convention.
2. **Background `setInterval` in the server.** Deterministic cadence, but timers inside
   Next route modules are fragile across worker/module-reload lifecycles and are a
   pattern this codebase deliberately avoids. Rejected.
3. **Scheduler in Electron main (`electron/main.ts`).** Clean separation, but it would
   **only cover the Electron app — the Docker DB (the big one) would never
   auto-purge.** Disqualified by the dual-DB reality.

## Architecture

### 1. `src/lib/db.ts` — new functions (synchronous, pure, unit-testable)

- `getStorageInfo(): StorageInfo` — DB + WAL file sizes (via `fs.statSync` on the
  `.db` and `.db-wal` paths from `getDbPath()`), per-table row counts (`sessions`,
  `agents`, `agent_events`, `token_usage`, `daily_usage`), and oldest/newest
  `sessions.started_at`.
  Throughout, **`cutoffMs` is an absolute epoch-ms boundary: rows with
  `started_at < cutoffMs` (events: `timestamp < cutoffMs`) are the ones purged.**
  (The existing `deleteOldSessions` takes a *duration* and computes
  `Date.now() - olderThanMs` internally; the shared `DELETE` statements will be
  factored into a small helper that takes the absolute `cutoffMs`, and
  `deleteOldSessions` becomes a thin wrapper over it so its one call site is
  unaffected.)
- `previewPurge(cutoffMs): PurgeCounts` — how many `sessions`/`agents`/`agent_events`/
  `token_usage` rows fall before `cutoffMs`. **No writes** (dry run for the UI
  preview). Uses the same predicate as the delete helper so preview == actual.
- `purgeOlderThan(cutoffMs, opts?: { vacuum?: boolean }): PurgeResult` —
  1. **Roll up first:** capture the full deleted span into `daily_usage`. Because
     `rollupDailyUsageRange` caps at 92 days, purging data older than ~122 days would
     otherwise skip the oldest slice — so this path rolls up the whole
     `[oldest_started_at, cutoffMs)` range, chunked into ≤92-day windows (or a
     dedicated uncapped rollup helper). See Edge Cases.
  2. **Delete:** call the shared absolute-cutoff delete helper (wrapped in a
     transaction) to remove raw rows before `cutoffMs`, leaving `daily_usage`.
  3. **Reclaim (optional):** if `opts.vacuum`, run `VACUUM` (outside the transaction)
     to shrink the file. Returns `{ deleted: PurgeCounts, bytes_freed }` (bytes from
     file size before/after).
- `getSetting(key)` / `setSetting(key, value)` — helpers over a new key-value table:
  ```sql
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
  Created in the same `getDb()` bootstrap block as the other tables. Keys:
  `retention_enabled` (`"0"`/`"1"`), `retention_days` (e.g. `"30"`), `last_purge_at`
  (ms epoch as string). Server-side config has to live where the server owns it, and
  this travels with the DB per-instance.
- `runRetentionIfDue(nowMs): PurgeResult | null` — reads the three settings; if
  `retention_enabled` and `nowMs - last_purge_at > 24h`, calls
  `purgeOlderThan(nowMs - retention_days*86400000, { vacuum: false })`, sets
  `last_purge_at = nowMs`, and returns the result; otherwise returns `null`.
  **Skips full VACUUM** to keep the hot stats path lock-free.

### 2. API routes (standard envelope)

- `GET /api/monitor/storage` → `StorageInfo`.
- `GET /api/monitor/purge?days=N` → `{ cutoff_ms, would_delete: PurgeCounts }`
  (preview; `days` omitted or `0`/`all` → "Everything", cutoff = `now`).
- `POST /api/monitor/purge` body `{ days }` → runs `purgeOlderThan(..., { vacuum:true })`
  (or `clearAllMonitorData()` for "Everything"), broadcasts `stats_updated`, returns
  `{ deleted, bytes_freed }`.
- `GET /api/monitor/retention` → `{ enabled, days, last_purge_at }`.
  `PUT /api/monitor/retention` body `{ enabled, days }` → persists via `setSetting`,
  returns the stored policy.
- `GET /api/monitor/stats` — add one line: `try { runRetentionIfDue(Date.now()); }
  catch { /* ignore */ }` alongside the existing `abandonStaleSessions()` /
  `archiveStaleAgents()` calls.

### 3. `src/components/settings/DataManagement.tsx` (new)

A card matching the existing Settings cards (zinc borders, dark theme, red for the
destructive action; mirrors the confirm popover already used in `AgentMonitorPanel`).

- **Storage summary** (from `/api/monitor/storage`): e.g.
  "15.2 MB · 224 sessions · 17,683 events · Mar 16 – Jul 14".
- **Manual purge:** window `<select>` `[7 days · 30 days · 90 days · 180 days ·
  Everything]` → on change, `GET …/purge?days=N` fills a live preview line
  ("Removes ≈N sessions, M events · frees ~X MB") → **Purge now** button → confirm
  popover ("Delete data older than 30 days? This cannot be undone.") → `POST …/purge`
  → inline result ("Removed 41 sessions, 3,279 events · freed 4.1 MB").
- **Retention policy:** a toggle "Automatically purge data older than `[30 days ▾]`"
  bound to `GET|PUT /api/monitor/retention`, with helper text "Runs about once a day
  while the tracker is open." Default window **30 days** when first enabled.

Fetching uses the repo's SWR pattern; a small `use-storage`/inline hook is fine.

### 4. `src/app/settings/page.tsx`

Insert `<DataManagement />` as a new card (below "Agent Monitor Display"). No other
changes to the page.

### 5. `src/types/index.ts`

Add `StorageInfo`, `PurgeCounts`, `PurgeResult`, `RetentionPolicy`.

## Data flow (manual purge)

Open Settings → card loads `/api/monitor/storage` → user picks a window →
`GET /api/monitor/purge?days=30` fills preview → **Purge now** → confirm →
`POST /api/monitor/purge {days:30}` → `purgeOlderThan` rolls up → deletes → VACUUMs →
response shows freed space → `broadcastEvent({type:"stats_updated"})` → Monitor &
Dashboard refresh live via the SSE stream.

## Error handling

- All routes catch and return `{ success:false, error:{ code, message } }`; the card
  surfaces the message inline and leaves data untouched on failure.
- Deletes run inside a `better-sqlite3` transaction; `VACUUM` runs after it commits
  (VACUUM cannot run inside a transaction).
- `runRetentionIfDue` is wrapped in try/catch on the stats path (like the existing
  maintenance calls) so a purge failure never breaks the stats response, and it
  **skips the full VACUUM** to avoid an exclusive-lock stutter during event ingest.
- Preview and actual deletion share one predicate, so the confirmed count matches
  what the preview showed (barring new rows arriving in between — acceptable).

## Edge cases

- **Rollup 92-day cap:** `purgeOlderThan` must roll up the *entire* deleted span, not
  just the last 92 days, or history older than ~122 days would be dropped without a
  summary. Implement by chunking `[oldest, cutoff)` into ≤92-day windows and calling
  `rollupDailyUsageRange` per chunk, or add an uncapped internal rollup used only by
  the purge path. (Moot while `token_usage` is empty, but required for correctness.)
- **"Everything" window:** the age-based path deliberately preserves `daily_usage`
  (the user's "keep summaries" choice), but choosing **Everything** means a full data
  wipe — so that path reuses `clearAllMonitorData()` (the four raw tables) **plus a
  `daily_usage` delete**. `app_settings` (retention config, `last_purge_at`) is left
  intact, since it's configuration rather than tracked data. This distinction is
  documented in the POST handler.
- **Empty DB / no old rows:** preview shows 0, purge is a no-op returning zero counts;
  UI says "Nothing to purge."
- **Concurrent ingest during VACUUM:** small DB (tens of MB) → VACUUM is sub-second;
  acceptable for the manual path. Auto path skips it.

## Testing

The repo now has **Vitest** (added 2026-07-14: `npm test` → `vitest run`, config
`vitest.config.ts` with `environment: "node"`, `include: ["src/**/*.test.ts"]`, `@`→
`src` alias; existing `src/lib/__tests__/smoke.test.ts`). The `db.ts` purge functions
are pure and synchronous, so they get real unit tests here — and Node's default
`better-sqlite3` ABI runs fine under `vitest` (no Electron rebuild needed).

Unit tests — `src/lib/__tests__/purge.test.ts`, each opening a fresh in-memory DB
(`new Database(":memory:")`) with the schema bootstrapped, or a temp-file DB pointed
at via `LLM_DATA_DIR` so `getDb()` targets it:

- **Boundary correctness:** seed sessions/agents/events at known timestamps; a purge
  at cutoff C deletes exactly the rows with `started_at < C` (and their child
  agents/events/token_usage) and keeps the rest. Verify the exact-boundary row
  (`started_at === C`) is **kept**.
- **`previewPurge` == actual:** the preview counts equal what `purgeOlderThan`
  subsequently deletes for the same cutoff.
- **Summary retention:** after purging a span, `daily_usage` is populated for the
  purged days (including data older than the 92-day rollup cap) and is **not** deleted.
- **"Everything":** clears the four raw tables **and** `daily_usage`, but leaves
  `app_settings` intact.
- **`runRetentionIfDue` throttle:** with a fresh `last_purge_at`, a second call inside
  24h is a no-op; a call after 24h purges and advances `last_purge_at`; disabled
  policy never purges.
- **`app_settings` round-trip:** `setSetting`/`getSetting` persist and read back.

Plus the repo's existing verification: **`npm run build`** (strict typecheck) and a
brief live end-to-end check that `POST /api/monitor/purge` deletes rows, shrinks the
file, and triggers the Monitor/Dashboard SSE refresh.

## Defaults chosen (adjustable)

- Manual window options: 7 / 30 / 90 / 180 days / Everything.
- Default retention window when enabled: **30 days**.
- Auto-purge throttle: **24h**; auto path skips VACUUM, manual path runs it.
