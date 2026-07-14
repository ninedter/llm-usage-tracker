# Data Purge Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings "Data Management" section that purges old monitor data — a manual age-based purge plus an optional daily retention policy — so the SQLite DB doesn't grow unbounded.

**Architecture:** Pure synchronous `db.ts` functions do the work (preview / purge / storage-info / retention-throttle); thin Next API routes expose them; a React card in Settings drives them. Automatic retention rides the existing request-piggybacked maintenance path in `GET /api/monitor/stats` (no scheduler), so it covers both the Electron and Docker DBs. Purges roll the deleted span into `daily_usage` first so trend history survives; a full "Everything" wipe is the only path that also clears summaries.

**Tech Stack:** Next.js 16 App Router, React 19, `better-sqlite3` (synchronous), SWR, Tailwind CSS 4, Vitest (node environment).

## Global Constraints

- API responses use the envelope `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- Database access is synchronous `better-sqlite3` with raw prepared statements — no ORM, no async.
- Tailwind dark theme: zinc-900/950 surfaces, red for destructive actions. **Hard 12px font floor UI-wide** — never use a font size below `text-xs` (12px).
- Tests live at `src/**/*.test.ts`, run with `npm test` (`vitest run`), environment `node`, `@` alias → `src`.
- Absolute-cutoff convention: everywhere a `cutoffMs` appears it is an **absolute epoch-ms boundary** — rows with `started_at < cutoffMs` (events: `timestamp` tied to such sessions) are the ones removed.
- Defaults: manual windows 7 / 30 / 90 / 180 days / Everything; default retention window 30 days; auto-purge throttle 24h; auto path skips `VACUUM`, manual path runs it.

---

## File Structure

- `src/types/index.ts` — **Modify:** add `StorageInfo`, `PurgeCounts`, `PurgeResult`, `RetentionPolicy`.
- `src/lib/db.ts` — **Modify:** add `app_settings` table to bootstrap; add `getSetting`/`setSetting`, `deleteBefore`, `previewPurge`, `purgeOlderThan`, `purgeEverything`, `getStorageInfo`, `runRetentionIfDue`, private `dbFileBytes`/`rollupRangeChunked`; refactor `deleteOldSessions` onto `deleteBefore`.
- `src/lib/__tests__/purge.test.ts` — **Create:** unit tests for the db layer.
- `src/app/api/monitor/storage/route.ts` — **Create:** `GET` storage info.
- `src/app/api/monitor/purge/route.ts` — **Create:** `GET` preview + `POST` execute.
- `src/app/api/monitor/retention/route.ts` — **Create:** `GET`/`PUT` policy.
- `src/app/api/monitor/stats/route.ts` — **Modify:** call `runRetentionIfDue`.
- `src/app/api/monitor/__tests__/purge-routes.test.ts` — **Create:** route handler tests.
- `src/hooks/use-data-management.ts` — **Create:** SWR hooks + purge/retention actions.
- `src/components/settings/DataManagement.tsx` — **Create:** the Settings card.
- `src/app/settings/page.tsx` — **Modify:** render `<DataManagement />`.

---

## Task 1: Types + `app_settings` table + settings helpers

**Files:**
- Modify: `src/types/index.ts` (append to the file)
- Modify: `src/lib/db.ts` (bootstrap block ~line 86-103; new functions near the other CRUD helpers)
- Test: `src/lib/__tests__/purge.test.ts`

**Interfaces:**
- Produces: `StorageInfo`, `PurgeCounts`, `PurgeResult`, `RetentionPolicy` types; `getSetting(key: string): string | null`; `setSetting(key: string, value: string): void`.

- [ ] **Step 1: Add the types**

Append to `src/types/index.ts`:

```typescript
// --- Data Management / Purge ---

export interface StorageInfo {
  db_bytes: number;
  wal_bytes: number;
  counts: {
    sessions: number;
    agents: number;
    agent_events: number;
    token_usage: number;
    daily_usage: number;
  };
  oldest_ms: number | null;
  newest_ms: number | null;
}

export interface PurgeCounts {
  sessions: number;
  agents: number;
  events: number;
  token_usage: number;
}

export interface PurgeResult {
  deleted: PurgeCounts;
  bytes_freed: number;
  daily_usage_cleared?: number; // set only by a full "Everything" wipe
}

export interface RetentionPolicy {
  enabled: boolean;
  days: number;
  last_purge_at: number | null;
}
```

- [ ] **Step 2: Add the `app_settings` table to the bootstrap**

In `src/lib/db.ts`, inside `getDb()`, the `db.exec(\`...\`)` block that creates tables ends with the `daily_usage` table + its indexes (around line 86-102). Add this table right after the `idx_daily_usage_project` index line, still inside the same template string:

```sql
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
```

- [ ] **Step 3: Write the failing test**

Create `src/lib/__tests__/purge.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Load db only after LLM_DATA_DIR points at an isolated temp DB, so getDb()
// (lazy) opens the throwaway file rather than the real .data DB.
let db: typeof import("@/lib/db");

beforeAll(async () => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "purge-test-"));
  db = await import("@/lib/db");
});

function clearAll() {
  const d = db.getDb();
  for (const t of ["agent_events", "agents", "token_usage", "sessions", "daily_usage", "app_settings"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeEach(() => clearAll());

// --- shared seed helpers (reused by later tasks) ---
function seedSession(id: string, startedAt: number) {
  db.getDb()
    .prepare("INSERT INTO sessions (id,status,project,cwd,entrypoint,started_at,ended_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "completed", "proj", "", "cli", startedAt, startedAt + 1000, startedAt + 1000, null);
}
function seedAgent(id: string, sessionId: string) {
  db.getDb()
    .prepare("INSERT INTO agents (id,session_id,parent_agent_id,type,subagent_type,description,status,current_tool,started_at,ended_at,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, sessionId, null, "main", null, "d", "completed", null, 0, null, null, 0);
}
function seedEvent(sessionId: string, ts: number) {
  db.getDb()
    .prepare("INSERT INTO agent_events (agent_id,session_id,event_type,tool_name,summary,content,files_affected,timestamp,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("a1", sessionId, "tool_call", "Read", null, null, null, ts, ts);
}
function seedTokenUsage(sessionId: string, model = "claude", cost = 1) {
  db.getDb()
    .prepare("INSERT INTO token_usage (session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(sessionId, model, 100, 50, 0, 0, cost, 0);
}
export { }; // keep this a module

describe("app_settings", () => {
  it("round-trips a setting", () => {
    db.setSetting("retention_days", "30");
    expect(db.getSetting("retention_days")).toBe("30");
  });
  it("returns null for a missing key", () => {
    expect(db.getSetting("does_not_exist")).toBeNull();
  });
  it("overwrites an existing key", () => {
    db.setSetting("k", "1");
    db.setSetting("k", "2");
    expect(db.getSetting("k")).toBe("2");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- purge`
Expected: FAIL — `db.setSetting is not a function` (helpers not implemented yet).

- [ ] **Step 5: Implement the helpers**

In `src/lib/db.ts`, add near the other exported CRUD functions (e.g. just above `// --- Cleanup ---`):

```typescript
// --- App settings (key-value) ---

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- purge`
Expected: PASS (3 passing in the `app_settings` describe).

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/lib/db.ts src/lib/__tests__/purge.test.ts
git commit -m "feat(db): app_settings table + get/setSetting + purge types"
```

---

## Task 2: Absolute-cutoff delete core + `previewPurge`

**Files:**
- Modify: `src/lib/db.ts` (`deleteOldSessions` at ~line 431; add `deleteBefore`, `previewPurge`)
- Test: `src/lib/__tests__/purge.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `PurgeCounts` (Task 1), the seed helpers in `purge.test.ts`.
- Produces: `deleteBefore(cutoffMs: number): PurgeCounts`; `previewPurge(cutoffMs: number): PurgeCounts`; `deleteOldSessions` keeps its signature `(olderThanMs: number) => number`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/purge.test.ts`:

```typescript
describe("previewPurge / deleteBefore", () => {
  it("counts and deletes only rows strictly before the cutoff, keeping the boundary row", () => {
    const cutoff = 1_000_000;
    seedSession("old", cutoff - 1);
    seedAgent("ag-old", "old");
    seedEvent("old", cutoff - 1);
    seedSession("edge", cutoff); // exactly at cutoff → kept
    seedEvent("edge", cutoff);
    seedSession("new", cutoff + 1); // newer → kept
    seedEvent("new", cutoff + 1);

    expect(db.previewPurge(cutoff)).toEqual({ sessions: 1, agents: 1, events: 1, token_usage: 0 });

    const deleted = db.deleteBefore(cutoff);
    expect(deleted).toEqual({ sessions: 1, agents: 1, events: 1, token_usage: 0 });

    // preview is now empty and boundary + newer rows survive
    expect(db.previewPurge(cutoff)).toEqual({ sessions: 0, agents: 0, events: 0, token_usage: 0 });
    const d = db.getDb();
    expect((d.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge`
Expected: FAIL — `db.previewPurge is not a function`.

- [ ] **Step 3: Implement `deleteBefore` + `previewPurge` and refactor `deleteOldSessions`**

In `src/lib/db.ts`, replace the existing `deleteOldSessions` function (currently ~line 431-439):

```typescript
export function deleteOldSessions(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const d = getDb();
  d.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  d.prepare("DELETE FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  d.prepare("DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  const result = d.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoff);
  return result.changes;
}
```

with:

```typescript
// Delete every raw row tied to a session started before an absolute epoch-ms
// cutoff. Runs in one transaction. Leaves daily_usage intact.
export function deleteBefore(cutoffMs: number): import("@/types").PurgeCounts {
  const d = getDb();
  const run = d.transaction((): import("@/types").PurgeCounts => {
    const events = d.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const agents = d.prepare("DELETE FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const token_usage = d.prepare("DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const sessions = d.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoffMs).changes;
    return { sessions, agents, events, token_usage };
  });
  return run();
}

// Back-compat wrapper: existing callers pass a duration, not an absolute time.
export function deleteOldSessions(olderThanMs: number): number {
  return deleteBefore(Date.now() - olderThanMs).sessions;
}

// Count what deleteBefore(cutoffMs) would remove — same predicate, no writes.
export function previewPurge(cutoffMs: number): import("@/types").PurgeCounts {
  const d = getDb();
  const one = (sql: string) => (d.prepare(sql).get(cutoffMs) as { n: number }).n;
  return {
    sessions: one("SELECT COUNT(*) n FROM sessions WHERE started_at < ?"),
    agents: one("SELECT COUNT(*) n FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
    events: one("SELECT COUNT(*) n FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
    token_usage: one("SELECT COUNT(*) n FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- purge`
Expected: PASS (the new describe block + all Task 1 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/__tests__/purge.test.ts
git commit -m "feat(db): deleteBefore + previewPurge (absolute cutoff), refactor deleteOldSessions"
```

---

## Task 3: `purgeOlderThan` + `purgeEverything` (rollup, delete, vacuum)

**Files:**
- Modify: `src/lib/db.ts` (add `statSync` import; add `dbFileBytes`, `rollupRangeChunked`, `purgeOlderThan`, `purgeEverything`)
- Test: `src/lib/__tests__/purge.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `deleteBefore` (Task 2), existing `clearAllMonitorData` (~line 442) and `rollupDailyUsageRange` (~line 485), `PurgeResult` type.
- Produces: `purgeOlderThan(cutoffMs: number, opts?: { vacuum?: boolean }): PurgeResult`; `purgeEverything(opts?: { vacuum?: boolean }): PurgeResult`; private `dbFileBytes(): number`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/purge.test.ts`:

```typescript
describe("purgeOlderThan / purgeEverything", () => {
  it("rolls a >92-day-old span into daily_usage before deleting, and keeps the summary", () => {
    const oldDay = new Date("2026-01-01T12:00:00").getTime();
    seedSession("old", oldDay);
    seedTokenUsage("old"); // gives the rollup something to summarize
    const cutoff = new Date("2026-06-01T00:00:00").getTime(); // ~5 months later (> 92d)

    const res = db.purgeOlderThan(cutoff, { vacuum: false });

    expect(res.deleted.sessions).toBe(1);
    expect(res.deleted.token_usage).toBe(1);
    const d = db.getDb();
    expect((d.prepare("SELECT COUNT(*) n FROM daily_usage").get() as { n: number }).n).toBeGreaterThan(0);
    expect((d.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(0);
  });

  it("purgeEverything clears raw tables AND daily_usage but keeps app_settings", () => {
    seedSession("s", 100);
    db.getDb().prepare("INSERT INTO daily_usage (date,model,project,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,session_count,tool_calls,tool_failures) VALUES ('2026-01-01','m','',0,0,0,0,0,0,0,0)").run();
    db.setSetting("retention_enabled", "1");

    const res = db.purgeEverything({ vacuum: false });

    expect(res.deleted.sessions).toBe(1);
    expect(res.daily_usage_cleared).toBeGreaterThan(0);
    const d = db.getDb();
    expect((d.prepare("SELECT COUNT(*) n FROM daily_usage").get() as { n: number }).n).toBe(0);
    expect(db.getSetting("retention_enabled")).toBe("1"); // config survives
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge`
Expected: FAIL — `db.purgeOlderThan is not a function`.

- [ ] **Step 3: Add the `statSync` import**

In `src/lib/db.ts`, change the fs import (line 3):

```typescript
import { existsSync, mkdirSync } from "fs";
```

to:

```typescript
import { existsSync, mkdirSync, statSync } from "fs";
```

- [ ] **Step 4: Implement the purge functions**

In `src/lib/db.ts`, add after `clearAllMonitorData` (~line 449):

```typescript
function dbFileBytes(): number {
  try { return statSync(getDbPath()).size; } catch { return 0; }
}

// Roll up [from, to) into daily_usage in <=92-day chunks. rollupDailyUsageRange
// caps its own scan at 92 days, so a single call over a longer span would skip
// the oldest slice — chunking guarantees the whole deleted span is summarized.
function rollupRangeChunked(from: number, to: number): void {
  const CHUNK = 92 * 86400000;
  let cursor = from;
  while (cursor < to) {
    const end = Math.min(cursor + CHUNK, to);
    rollupDailyUsageRange(cursor, end);
    cursor = end;
  }
}

// Age-based purge: summarize the deleted span into daily_usage (preserved),
// delete raw rows before cutoffMs, optionally VACUUM to reclaim file space.
export function purgeOlderThan(cutoffMs: number, opts?: { vacuum?: boolean }): import("@/types").PurgeResult {
  const d = getDb();
  const oldest = (d.prepare("SELECT MIN(started_at) m FROM sessions WHERE started_at < ?").get(cutoffMs) as { m: number | null }).m;
  if (oldest != null) rollupRangeChunked(oldest, cutoffMs);

  const before = dbFileBytes();
  const deleted = deleteBefore(cutoffMs);
  if (opts?.vacuum) d.exec("VACUUM");
  const after = dbFileBytes();
  return { deleted, bytes_freed: Math.max(0, before - after) };
}

// Full wipe: all raw tables plus daily_usage. Keeps app_settings (config).
export function purgeEverything(opts?: { vacuum?: boolean }): import("@/types").PurgeResult {
  const d = getDb();
  const before = dbFileBytes();
  const raw = clearAllMonitorData();
  const daily = d.prepare("DELETE FROM daily_usage").run().changes;
  if (opts?.vacuum) d.exec("VACUUM");
  const after = dbFileBytes();
  return {
    deleted: { sessions: raw.sessions, agents: raw.agents, events: raw.events, token_usage: raw.token_usage },
    bytes_freed: Math.max(0, before - after),
    daily_usage_cleared: daily,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- purge`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/__tests__/purge.test.ts
git commit -m "feat(db): purgeOlderThan + purgeEverything with chunked rollup and vacuum"
```

---

## Task 4: `getStorageInfo`

**Files:**
- Modify: `src/lib/db.ts` (add `getStorageInfo`)
- Test: `src/lib/__tests__/purge.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `dbFileBytes` (Task 3), `getDbPath` (existing), `StorageInfo` type.
- Produces: `getStorageInfo(): StorageInfo`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/purge.test.ts`:

```typescript
describe("getStorageInfo", () => {
  it("reports per-table counts and the session time range", () => {
    seedSession("a", 1000);
    seedSession("b", 5000);
    seedEvent("a", 1200);

    const info = db.getStorageInfo();
    expect(info.counts.sessions).toBe(2);
    expect(info.counts.agent_events).toBe(1);
    expect(info.oldest_ms).toBe(1000);
    expect(info.newest_ms).toBe(5000);
    expect(info.db_bytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge`
Expected: FAIL — `db.getStorageInfo is not a function`.

- [ ] **Step 3: Implement `getStorageInfo`**

In `src/lib/db.ts`, add after `purgeEverything`:

```typescript
export function getStorageInfo(): import("@/types").StorageInfo {
  const d = getDb();
  const count = (t: string) => (d.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  const range = d.prepare("SELECT MIN(started_at) oldest, MAX(started_at) newest FROM sessions").get() as { oldest: number | null; newest: number | null };
  let walBytes = 0;
  try { walBytes = statSync(getDbPath() + "-wal").size; } catch { /* no WAL file yet */ }
  return {
    db_bytes: dbFileBytes(),
    wal_bytes: walBytes,
    counts: {
      sessions: count("sessions"),
      agents: count("agents"),
      agent_events: count("agent_events"),
      token_usage: count("token_usage"),
      daily_usage: count("daily_usage"),
    },
    oldest_ms: range.oldest,
    newest_ms: range.newest,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- purge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/__tests__/purge.test.ts
git commit -m "feat(db): getStorageInfo (file sizes, counts, range)"
```

---

## Task 5: `runRetentionIfDue` (throttled auto-purge)

**Files:**
- Modify: `src/lib/db.ts` (add `runRetentionIfDue`)
- Test: `src/lib/__tests__/purge.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `getSetting`/`setSetting` (Task 1), `purgeOlderThan` (Task 3).
- Produces: `runRetentionIfDue(nowMs: number): PurgeResult | null`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/purge.test.ts`:

```typescript
describe("runRetentionIfDue", () => {
  it("no-ops when the policy is disabled", () => {
    seedSession("old", 0);
    expect(db.runRetentionIfDue(Date.now())).toBeNull();
  });

  it("purges when enabled and due, then throttles for 24h", () => {
    const now = 100 * 86400000; // arbitrary "day 100"
    seedSession("old", now - 40 * 86400000); // 40 days old
    db.setSetting("retention_enabled", "1");
    db.setSetting("retention_days", "30");

    const first = db.runRetentionIfDue(now);
    expect(first).not.toBeNull();
    expect(first!.deleted.sessions).toBe(1);

    // within 24h → throttled no-op even though new old data exists
    seedSession("old2", now - 40 * 86400000);
    expect(db.runRetentionIfDue(now + 3_600_000)).toBeNull();

    // after 24h → runs again
    const third = db.runRetentionIfDue(now + 25 * 3_600_000);
    expect(third).not.toBeNull();
    expect(third!.deleted.sessions).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge`
Expected: FAIL — `db.runRetentionIfDue is not a function`.

- [ ] **Step 3: Implement `runRetentionIfDue`**

In `src/lib/db.ts`, add after `getStorageInfo`:

```typescript
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Runs the retention purge at most once per 24h. Returns the purge result when
// it ran, or null when disabled/throttled/misconfigured. Called from the stats
// maintenance path; skips VACUUM to stay off the hot path's lock.
export function runRetentionIfDue(nowMs: number): import("@/types").PurgeResult | null {
  if (getSetting("retention_enabled") !== "1") return null;
  const days = parseInt(getSetting("retention_days") || "30", 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  const last = parseInt(getSetting("last_purge_at") || "0", 10);
  if (nowMs - last < RETENTION_INTERVAL_MS) return null;

  const result = purgeOlderThan(nowMs - days * 86400000, { vacuum: false });
  setSetting("last_purge_at", String(nowMs));
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- purge`
Expected: PASS (full db-layer suite green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/__tests__/purge.test.ts
git commit -m "feat(db): runRetentionIfDue throttled auto-purge"
```

---

## Task 6: Storage + retention API routes

**Files:**
- Create: `src/app/api/monitor/storage/route.ts`
- Create: `src/app/api/monitor/retention/route.ts`
- Test: `src/app/api/monitor/__tests__/purge-routes.test.ts` (create; storage + retention cases)

**Interfaces:**
- Consumes: `getStorageInfo` (Task 4), `getSetting`/`setSetting` (Task 1), types.
- Produces: `GET /api/monitor/storage` → `ApiResponse<StorageInfo>`; `GET|PUT /api/monitor/retention` → `ApiResponse<RetentionPolicy>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/monitor/__tests__/purge-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

let db: typeof import("@/lib/db");
let storageRoute: typeof import("@/app/api/monitor/storage/route");
let retentionRoute: typeof import("@/app/api/monitor/retention/route");

beforeAll(async () => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "purge-routes-"));
  db = await import("@/lib/db");
  storageRoute = await import("@/app/api/monitor/storage/route");
  retentionRoute = await import("@/app/api/monitor/retention/route");
});

function clearAll() {
  const d = db.getDb();
  for (const t of ["agent_events", "agents", "token_usage", "sessions", "daily_usage", "app_settings"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
}
beforeEach(() => clearAll());

function seedSession(id: string, startedAt: number) {
  db.getDb()
    .prepare("INSERT INTO sessions (id,status,project,cwd,entrypoint,started_at,ended_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "completed", "p", "", "cli", startedAt, null, startedAt, null);
}

describe("GET /api/monitor/storage", () => {
  it("returns table counts", async () => {
    seedSession("a", 1000);
    const res = await storageRoute.GET();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.counts.sessions).toBe(1);
  });
});

describe("/api/monitor/retention", () => {
  it("PUT then GET round-trips the policy", async () => {
    const putReq = new NextRequest("http://x/api/monitor/retention", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, days: 14 }),
      headers: { "Content-Type": "application/json" },
    });
    const putJson = await (await retentionRoute.PUT(putReq)).json();
    expect(putJson.data.enabled).toBe(true);
    expect(putJson.data.days).toBe(14);

    const getJson = await (await retentionRoute.GET()).json();
    expect(getJson.data.enabled).toBe(true);
    expect(getJson.data.days).toBe(14);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge-routes`
Expected: FAIL — cannot import `@/app/api/monitor/storage/route` (module not found).

- [ ] **Step 3: Implement the storage route**

Create `src/app/api/monitor/storage/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getStorageInfo } from "@/lib/db";
import type { ApiResponse, StorageInfo } from "@/types";

export const dynamic = "force-dynamic";

// GET /api/monitor/storage — DB size, per-table counts, session time range
export async function GET(): Promise<NextResponse<ApiResponse<StorageInfo>>> {
  try {
    return NextResponse.json({ success: true, data: getStorageInfo() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : "Failed to read storage info" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4: Implement the retention route**

Create `src/app/api/monitor/retention/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import type { ApiResponse, RetentionPolicy } from "@/types";

export const dynamic = "force-dynamic";

function readPolicy(): RetentionPolicy {
  const last = parseInt(getSetting("last_purge_at") || "0", 10);
  return {
    enabled: getSetting("retention_enabled") === "1",
    days: parseInt(getSetting("retention_days") || "30", 10),
    last_purge_at: last > 0 ? last : null,
  };
}

// GET /api/monitor/retention — current policy
export async function GET(): Promise<NextResponse<ApiResponse<RetentionPolicy>>> {
  try {
    return NextResponse.json({ success: true, data: readPolicy() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "RETENTION_ERROR", message: error instanceof Error ? error.message : "Failed to read retention policy" } },
      { status: 500 }
    );
  }
}

// PUT /api/monitor/retention — { enabled?, days? }
export async function PUT(req: NextRequest): Promise<NextResponse<ApiResponse<RetentionPolicy>>> {
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.enabled === "boolean") setSetting("retention_enabled", body.enabled ? "1" : "0");
    if (typeof body.days === "number" && body.days > 0) setSetting("retention_days", String(Math.floor(body.days)));
    return NextResponse.json({ success: true, data: readPolicy() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "RETENTION_ERROR", message: error instanceof Error ? error.message : "Failed to update retention policy" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- purge-routes`
Expected: PASS (storage + retention describes).

> If `next/server` fails to load under Vitest, verify these two routes live with `npm run build` + curl (`GET /api/monitor/storage`, `PUT/GET /api/monitor/retention`) and keep the db-layer unit tests as the safety net. Do not delete the test file — report the import error.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/monitor/storage/route.ts src/app/api/monitor/retention/route.ts src/app/api/monitor/__tests__/purge-routes.test.ts
git commit -m "feat(api): storage + retention routes"
```

---

## Task 7: Purge API route + stats wiring

**Files:**
- Create: `src/app/api/monitor/purge/route.ts`
- Modify: `src/app/api/monitor/stats/route.ts` (add `runRetentionIfDue` call)
- Test: `src/app/api/monitor/__tests__/purge-routes.test.ts` (add purge describe block)

**Interfaces:**
- Consumes: `previewPurge` (Task 2), `purgeOlderThan`/`purgeEverything` (Task 3), `runRetentionIfDue` (Task 5), `broadcastEvent` (existing `src/lib/ws.ts`), types.
- Produces: `GET /api/monitor/purge?days=N` → `ApiResponse<{ cutoff_ms; would_delete: PurgeCounts }>`; `POST /api/monitor/purge` `{ days }` → `ApiResponse<PurgeResult>`.

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/monitor/__tests__/purge-routes.test.ts`. First extend the `beforeAll` to also import the purge route (add this line alongside the other imports inside `beforeAll`):

```typescript
  purgeRoute = await import("@/app/api/monitor/purge/route");
```

and declare it at the top with the other `let` bindings:

```typescript
let purgeRoute: typeof import("@/app/api/monitor/purge/route");
```

Then add the describe block:

```typescript
describe("/api/monitor/purge", () => {
  it("GET previews rows older than the window", async () => {
    seedSession("old", Date.now() - 40 * 86400000);
    seedSession("new", Date.now() - 1 * 86400000);
    const req = new NextRequest("http://x/api/monitor/purge?days=30");
    const json = await (await purgeRoute.GET(req)).json();
    expect(json.success).toBe(true);
    expect(json.data.would_delete.sessions).toBe(1);
  });

  it("POST deletes rows older than the window", async () => {
    seedSession("old", Date.now() - 40 * 86400000);
    seedSession("new", Date.now() - 1 * 86400000);
    const req = new NextRequest("http://x/api/monitor/purge", {
      method: "POST",
      body: JSON.stringify({ days: 30 }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await (await purgeRoute.POST(req)).json();
    expect(json.success).toBe(true);
    expect(json.data.deleted.sessions).toBe(1);
    expect(db.getStorageInfo().counts.sessions).toBe(1); // the newer one remains
  });

  it("POST with days='all' wipes everything", async () => {
    seedSession("a", 1000);
    const req = new NextRequest("http://x/api/monitor/purge", {
      method: "POST",
      body: JSON.stringify({ days: "all" }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await (await purgeRoute.POST(req)).json();
    expect(json.data.deleted.sessions).toBe(1);
    expect(db.getStorageInfo().counts.sessions).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- purge-routes`
Expected: FAIL — cannot import `@/app/api/monitor/purge/route`.

- [ ] **Step 3: Implement the purge route**

Create `src/app/api/monitor/purge/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { previewPurge, purgeOlderThan, purgeEverything } from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse, PurgeCounts, PurgeResult } from "@/types";

export const dynamic = "force-dynamic";

// Positive int → that many days; omitted / 0 / "all" → full wipe.
function parseDays(param: string | number | null | undefined): number | "all" {
  if (param === null || param === undefined || param === "all") return "all";
  const n = typeof param === "number" ? param : parseInt(param, 10);
  if (!Number.isFinite(n) || n <= 0) return "all";
  return Math.floor(n);
}

// GET /api/monitor/purge?days=N — dry-run preview
export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<{ cutoff_ms: number; would_delete: PurgeCounts }>>> {
  try {
    const days = parseDays(req.nextUrl.searchParams.get("days"));
    const cutoff = days === "all" ? Date.now() : Date.now() - days * 86400000;
    return NextResponse.json({ success: true, data: { cutoff_ms: cutoff, would_delete: previewPurge(cutoff) } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "PURGE_PREVIEW_ERROR", message: error instanceof Error ? error.message : "Failed to preview purge" } },
      { status: 500 }
    );
  }
}

// POST /api/monitor/purge — { days } — execute (with VACUUM)
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<PurgeResult>>> {
  try {
    const body = await req.json().catch(() => ({}));
    const days = parseDays(body?.days);
    const result = days === "all"
      ? purgeEverything({ vacuum: true })
      : purgeOlderThan(Date.now() - days * 86400000, { vacuum: true });
    broadcastEvent({ type: "stats_updated", data: result });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "PURGE_ERROR", message: error instanceof Error ? error.message : "Failed to purge data" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4: Wire retention into the stats route**

In `src/app/api/monitor/stats/route.ts`, change the import line:

```typescript
import { getMonitorStats, abandonStaleSessions, archiveStaleAgents } from "@/lib/db";
```

to:

```typescript
import { getMonitorStats, abandonStaleSessions, archiveStaleAgents, runRetentionIfDue } from "@/lib/db";
```

and inside the `try` block, right after `archiveStaleAgents();`, add:

```typescript
    try { runRetentionIfDue(Date.now()); } catch { /* retention failure must not break stats */ }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- purge-routes`
Expected: PASS (storage + retention + purge describes).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS (smoke + purge + purge-routes).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/monitor/purge/route.ts src/app/api/monitor/stats/route.ts src/app/api/monitor/__tests__/purge-routes.test.ts
git commit -m "feat(api): purge preview/execute route + wire auto-retention into stats"
```

---

## Task 8: Settings "Data Management" card (hook + component + page)

**Files:**
- Create: `src/hooks/use-data-management.ts`
- Create: `src/components/settings/DataManagement.tsx`
- Modify: `src/app/settings/page.tsx` (import + render the card)

**Interfaces:**
- Consumes: `GET /api/monitor/storage`, `GET|PUT /api/monitor/retention`, `GET|POST /api/monitor/purge` (Tasks 6-7); types `StorageInfo`, `RetentionPolicy`, `PurgeCounts`, `PurgeResult`.
- Produces: `useDataManagement()` hook; `<DataManagement />` component.

> No unit test: the repo's Vitest environment is `node` (no jsdom), and the codebase does not test React components. Verify via `npm run build` (strict typecheck) + `npm test` (all suites green) + a live end-to-end check.

- [ ] **Step 1: Create the hook**

Create `src/hooks/use-data-management.ts`:

```typescript
"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { ApiResponse, StorageInfo, RetentionPolicy, PurgeCounts, PurgeResult } from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

export type PurgeWindow = number | "all";

export function useDataManagement() {
  const storage = useSWR<StorageInfo>("/api/monitor/storage", fetcher);
  const retention = useSWR<RetentionPolicy>("/api/monitor/retention", fetcher);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async (days: PurgeWindow): Promise<PurgeCounts> => {
    const q = days === "all" ? "all" : String(days);
    const data = await fetcher<{ cutoff_ms: number; would_delete: PurgeCounts }>(`/api/monitor/purge?days=${q}`);
    return data.would_delete;
  }, []);

  const purge = useCallback(async (days: PurgeWindow): Promise<PurgeResult> => {
    setBusy(true);
    try {
      const res = await fetch("/api/monitor/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const json: ApiResponse<PurgeResult> = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Purge failed");
      await storage.mutate();
      return json.data as PurgeResult;
    } finally {
      setBusy(false);
    }
  }, [storage]);

  const setRetention = useCallback(async (patch: { enabled?: boolean; days?: number }) => {
    const res = await fetch("/api/monitor/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const json: ApiResponse<RetentionPolicy> = await res.json();
    if (json.success) retention.mutate(json.data, { revalidate: false });
  }, [retention]);

  return {
    storage: storage.data,
    retention: retention.data,
    busy,
    preview,
    purge,
    setRetention,
    refreshStorage: storage.mutate,
  };
}
```

- [ ] **Step 2: Create the component**

Create `src/components/settings/DataManagement.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useDataManagement, type PurgeWindow } from "@/hooks/use-data-management";
import type { PurgeCounts, PurgeResult } from "@/types";

const WINDOWS: { label: string; value: PurgeWindow }[] = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "180 days", value: 180 },
  { label: "Everything", value: "all" },
];

const RETENTION_DAYS = [7, 14, 30, 60, 90, 180];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDay(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DataManagement() {
  const { storage, retention, busy, preview, purge, setRetention } = useDataManagement();

  const [windowValue, setWindowValue] = useState<PurgeWindow>(30);
  const [counts, setCounts] = useState<PurgeCounts | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<PurgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load a dry-run preview whenever the window changes
  useEffect(() => {
    let active = true;
    setCounts(null);
    preview(windowValue)
      .then((c) => { if (active) setCounts(c); })
      .catch(() => { if (active) setCounts(null); });
    return () => { active = false; };
  }, [windowValue, preview]);

  const handlePurge = useCallback(async () => {
    setError(null);
    try {
      const res = await purge(windowValue);
      setResult(res);
      setShowConfirm(false);
      const fresh = await preview(windowValue);
      setCounts(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purge failed");
    }
  }, [purge, preview, windowValue]);

  const isEverything = windowValue === "all";
  const nothingToPurge = counts != null && counts.sessions === 0 && counts.events === 0;

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Data Management</h3>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        Purge old monitor data to keep the local database small. Trend summaries are kept unless you purge everything.
      </p>

      {/* Storage summary */}
      <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        {storage ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="font-semibold text-zinc-800 dark:text-zinc-100">{formatBytes(storage.db_bytes + storage.wal_bytes)}</span>
            <span>{storage.counts.sessions.toLocaleString()} sessions</span>
            <span>{storage.counts.agent_events.toLocaleString()} events</span>
            <span>{formatDay(storage.oldest_ms)} – {formatDay(storage.newest_ms)}</span>
          </div>
        ) : (
          <div className="text-xs text-zinc-400">Loading storage…</div>
        )}
      </div>

      {/* Manual purge */}
      <div className="mb-5 flex flex-col gap-2">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Delete data older than</label>
        <div className="flex items-center gap-2">
          <select
            value={String(windowValue)}
            onChange={(e) => {
              const v = e.target.value;
              setWindowValue(v === "all" ? "all" : Number(v));
              setResult(null);
            }}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {WINDOWS.map((w) => (
              <option key={String(w.value)} value={String(w.value)}>{w.label}</option>
            ))}
          </select>

          <div className="relative">
            <button
              onClick={() => setShowConfirm((s) => !s)}
              disabled={busy || nothingToPurge}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? "Purging…" : "Purge now"}
            </button>
            {showConfirm && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowConfirm(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-lg border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    {isEverything ? "Delete ALL monitor data?" : `Delete data older than ${windowValue} days?`}
                  </p>
                  <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                    {counts
                      ? `Removes ~${counts.sessions.toLocaleString()} sessions, ${counts.events.toLocaleString()} events.`
                      : "Calculating…"}{" "}
                    {isEverything ? "Summaries are cleared too. " : "Trend summaries are kept. "}This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePurge}
                      disabled={busy}
                      className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {busy ? "Purging…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setShowConfirm(false)}
                      className="rounded-md px-3 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Preview / result / error line */}
        <div className="min-h-[1rem] text-xs">
          {error ? (
            <span className="text-red-500">{error}</span>
          ) : result ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              Removed {result.deleted.sessions.toLocaleString()} sessions, {result.deleted.events.toLocaleString()} events · freed {formatBytes(result.bytes_freed)}
            </span>
          ) : counts ? (
            nothingToPurge ? (
              <span className="text-zinc-400">Nothing to purge in this window.</span>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-400">
                Removes ~{counts.sessions.toLocaleString()} sessions, {counts.events.toLocaleString()} events
              </span>
            )
          ) : (
            <span className="text-zinc-400">Calculating…</span>
          )}
        </div>
      </div>

      {/* Retention policy */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={retention?.enabled ?? false}
            onChange={(e) => setRetention({ enabled: e.target.checked })}
            className="h-3.5 w-3.5 accent-red-600"
          />
          Automatically purge data older than
          <select
            value={retention?.days ?? 30}
            onChange={(e) => setRetention({ days: Number(e.target.value) })}
            disabled={!retention?.enabled}
            className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            {RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </select>
        </label>
        <p className="mt-1.5 text-xs text-zinc-400">Runs about once a day while the tracker is open.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render the card in Settings**

In `src/app/settings/page.tsx`, add the import after the existing settings imports (after line 7):

```typescript
import { DataManagement } from "@/components/settings/DataManagement";
```

Then render it right after the "Agent Monitor Display" card's closing `</div>` (the one that closes the block opened at line 55) and before `<ProviderStatus />` (line 109):

```tsx
      <DataManagement />
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `npm run build`
Expected: compiles with no type errors.

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Live end-to-end verification**

Against the running app (Docker instance at `http://localhost:3789` for the real DB, or `npx electron .` after a build) open **Settings**:
- The Data Management card shows a real size + counts + date range.
- Pick "30 days" → the preview line shows non-zero counts (given data older than 30 days exists).
- Click **Purge now → Confirm** → the result line reports removed counts + freed space, and the storage summary updates. Confirm rows older than 30 days are gone via `sqlite3 .docker-data/agent-monitor.db "SELECT COUNT(*) FROM sessions WHERE started_at < strftime('%s','now','-30 days')*1000;"` returning `0`.
- Toggle the retention checkbox on, choose a window; reload Settings and confirm it persists (`GET /api/monitor/retention` reflects it).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-data-management.ts src/components/settings/DataManagement.tsx src/app/settings/page.tsx
git commit -m "feat(settings): Data Management card — manual purge + retention policy"
```

---

## Self-Review

**Spec coverage:**
- Manual age-based purge → Tasks 2, 3, 7, 8 ✓
- Optional retention policy (default 30d, 24h throttle, request-piggybacked) → Tasks 1, 5, 7 ✓
- Preserve `daily_usage` summaries (chunked rollup past the 92-day cap) → Task 3 ✓
- "Everything" wipes summaries too, keeps `app_settings` → Task 3 (`purgeEverything`), Task 7 (POST `days="all"`) ✓
- `app_settings` key-value table → Task 1 ✓
- Reuse dead-code `deleteOldSessions` / `clearAllMonitorData` → Task 2 (refactor), Task 3 (reuse) ✓
- Storage visibility (size + counts + range) → Task 4, Task 8 ✓
- API envelope, VACUUM on manual only, broadcast `stats_updated` → Tasks 6-7 ✓
- Vitest unit tests (boundary, preview==actual, summary retention, throttle) → Tasks 1-5, plus route tests 6-7 ✓
- Dual-DB: purge operates on the serving process's DB; retention rides the shared stats path → Task 7 ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; the one conditional note (Vitest + `next/server`) gives an explicit fallback, not a placeholder.

**Type consistency:** `PurgeCounts` fields (`sessions`/`agents`/`events`/`token_usage`) are identical in `previewPurge`, `deleteBefore`, `purgeEverything`, and tests. `PurgeResult` (`deleted`, `bytes_freed`, optional `daily_usage_cleared`) is consistent across `purgeOlderThan`/`purgeEverything`/routes/hook. `runRetentionIfDue(nowMs)` signature matches its call in the stats route. `parseDays` accepts `string | number | null | undefined`, matching both the query-string (GET) and JSON-body (POST) callers.
