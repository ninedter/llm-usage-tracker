# Performance Optimization & Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every measured hot path in the LLM Usage Tracker fast (7.2s analytics endpoint → <200ms, 1.7s sessions endpoint → <50ms, instant Electron window, no per-second JSON-parse storms), stop the packaged app from shipping the live DB + encryption key, then rebuild Docker + Electron and document everything.

**Architecture:** Next.js 16 App Router + React 19 + SWR frontend; better-sqlite3 (WAL) behind API routes; SSE for live updates; Electron thin-client of the always-on Docker tracker on :3789 with embedded-server fallback. None of that changes — this plan removes N+1 queries, adds caching/throttling at existing seams, memoizes hot React paths, and fixes the electron-builder file set.

**Tech Stack:** TypeScript strict, Next.js 16.1.6, React 19.2.3, SWR 2, better-sqlite3 12, Electron 35, electron-builder 26, vitest 2, Tailwind 4.

## Global Constraints

- **Never run `electron-rebuild`**; better-sqlite3 stays built for **system Node** everywhere. If NODE_MODULE_VERSION ever errors: `npm rebuild better-sqlite3`.
- The SQLite DB lives in the Docker **named volume** (`llm-tracker-data`); never bind-mount a SQLite dir on macOS.
- API response shape stays `{ success: true, data }` / `{ success: false, error: { code, message } }`.
- DB functions stay synchronous (better-sqlite3 is sync); raw SQL with prepared statements, no ORM.
- TypeScript strict mode; Tailwind for styling; dark theme zinc-900/950; **12px font floor** in UI (do not shrink any text).
- **No new runtime npm dependencies.**
- Baseline: **87 vitest tests pass**, `tsc --noEmit` clean, 1 pre-existing eslint error (fixed by Task 8). Every task must leave tests green.
- Measured baselines (Docker container, 58,487 events): `/api/analytics/tools` 7.23s, `/api/analytics/sessions` 1.71s, `/api/health` 1.43s, others <200ms.
- Commit after each task with a conventional-commit message.
- Working directory: `/Users/ninedter/Documents/Git Related/Misc Codes/LLMUsage/llm-usage-tracker` (paths below are relative to it).

---

### Task 1: `/api/live` liveness endpoint + container healthchecks + TZ param

The Electron launcher and Docker have no cheap liveness signal: `electron/main.ts` probes `/api/health`, which calls the Anthropic **and** OpenAI upstream APIs (1.4s, and slow SaaS = false "Docker down" = split-DB fallback). Docker has no HEALTHCHECK at all.

**Files:**
- Create: `src/app/api/live/route.ts`
- Modify: `Dockerfile` (add HEALTHCHECK), `docker-compose.yml` (healthcheck + TZ param)
- Test: `src/app/api/monitor/__tests__/live-route.test.ts`

**Interfaces:**
- Produces: `GET /api/live` → `200 {"success":true,"data":{"status":"ok"}}` with **zero I/O** (no DB, no upstream). Task 10 points the Electron probe at it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/monitor/__tests__/live-route.test.ts
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/live/route";

describe("GET /api/live", () => {
  it("returns ok without touching providers or DB", async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, data: { status: "ok" } });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '@/app/api/live/route'`)

Run: `npx vitest run src/app/api/monitor/__tests__/live-route.test.ts`

- [ ] **Step 3: Implement the route**

```typescript
// src/app/api/live/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness only: proves the HTTP server is up. Deliberately touches nothing —
// no DB, no provider APIs — so the Electron docker-probe and the container
// HEALTHCHECK measure *this server*, not Anthropic/OpenAI latency.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, data: { status: "ok" } });
}
```

- [ ] **Step 4: Run test — expect PASS**, then full suite: `npx vitest run` (88 passing)

- [ ] **Step 5: Add Docker HEALTHCHECK** — in `Dockerfile`, after `EXPOSE 3000`:

```dockerfile
# Liveness only — /api/live does no provider I/O, so this never hammers SaaS APIs
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

- [ ] **Step 6: docker-compose.yml** — inside the `tracker:` service add a matching healthcheck and make TZ overridable (keep the current default so day-bucketing behavior is unchanged):

```yaml
    environment:
      # Match the host timezone — SQLite 'localtime' day bucketing must agree
      # with the user's calendar or sessions land on the wrong day
      TZ: ${TZ:-Asia/Phnom_Penh}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
```

- [ ] **Step 7: Commit** — `feat(api): add zero-I/O /api/live liveness endpoint + container healthchecks`

---

### Task 2: Kill the N+1 analytics queries (7.2s → ~0.15s, 1.7s → ~20ms)

`getToolAnalytics` runs 2 extra queries **per tool** — the avg-duration one self-joins 58K events per tool (measured 6.1s of the 7.2s). `getSessionAnalytics` runs 3 correlated subqueries per emitted row (measured 1.7s). Single-pass rewrites were profiled in the live container: window-function pairing 82ms; grouped failures 19ms; sessions JOIN rewrite 18ms with row-identical output.

**Files:**
- Modify: `src/lib/db.ts:997-1061` (`getToolAnalytics`), `src/lib/db.ts:967-995` (`getSessionAnalytics`)
- Test: `src/lib/__tests__/analytics-queries.test.ts` (new)

**Interfaces:**
- Consumes: existing schema (`agent_events`, `sessions`, `token_usage`) — unchanged.
- Produces: same signatures. `getToolAnalytics(from, to, provider?)` → `ToolAnalytics`; `getSessionAnalytics(from, to, sort, order, limit, offset, provider?)` → `SessionAnalyticRow[]`. **Semantic improvement (intended):** `avg_duration_ms` now pairs each `tool_result` with its *nearest preceding* same-agent same-tool `tool_call` (≤300s) instead of cross-joining every call with every later result — old code inflated averages for repeated tools.

- [ ] **Step 1: Write the failing tests** — new file, follows the `provider-filter.test.ts` pattern (tmpdir + `LLM_DATA_DIR` before importing db):

```typescript
// src/lib/__tests__/analytics-queries.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "analytics-test-"));
});

import {
  getDb, createSession, createAgent, createEvent, upsertTokenUsage,
  getToolAnalytics, getSessionAnalytics,
} from "@/lib/db";

const T0 = Date.parse("2026-07-01T10:00:00Z");

function seed() {
  getDb();
  createSession({ id: "s1", status: "active", project: "proj", cwd: "/p", entrypoint: "cli", started_at: T0, ended_at: null, metadata: null });
  createAgent({ id: "a1", session_id: "s1", parent_agent_id: null, type: "main", subagent_type: null, description: "", status: "working", current_tool: null, started_at: T0, ended_at: null, metadata: null });
  // Read called twice: 1000ms and 3000ms call→result gaps → avg 2000
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Read", summary: "r1", content: null, files_affected: null, timestamp: T0 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Read", summary: "ok", content: null, files_affected: null, timestamp: T0 + 1000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Read", summary: "r2", content: null, files_affected: null, timestamp: T0 + 10_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Read", summary: "ok", content: null, files_affected: null, timestamp: T0 + 13_000 });
  // Bash: one call, one FAILING result
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Bash", summary: "b1", content: null, files_affected: null, timestamp: T0 + 20_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Bash", summary: "command failed with error", content: null, files_affected: null, timestamp: T0 + 21_000 });
  // Orphan result >300s after its call must NOT pair
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Glob", summary: "g1", content: null, files_affected: null, timestamp: T0 + 30_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Glob", summary: "ok", content: null, files_affected: null, timestamp: T0 + 30_000 + 301_000 });
  upsertTokenUsage({ session_id: "s1", model: "claude-opus", input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, cost: 1.25, updated_at: T0 });
}

describe("getToolAnalytics (single-pass rewrite)", () => {
  beforeAll(seed);

  it("counts calls per tool, ordered by count", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    const read = tools.find(t => t.tool_name === "Read")!;
    expect(read.call_count).toBe(2);
    expect(tools[0].tool_name).toBe("Read");
  });

  it("pairs each result with nearest preceding call within 300s", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    expect(tools.find(t => t.tool_name === "Read")!.avg_duration_ms).toBe(2000);
    expect(tools.find(t => t.tool_name === "Glob")!.avg_duration_ms).toBe(0); // orphan not paired
  });

  it("counts failures from result summaries and derives success rate", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    const bash = tools.find(t => t.tool_name === "Bash")!;
    expect(bash.failure_count).toBe(1);
    expect(bash.success_count).toBe(0);
    expect(bash.success_rate).toBe(0);
    const read = tools.find(t => t.tool_name === "Read")!;
    expect(read.failure_count).toBe(0);
    expect(read.success_rate).toBe(100);
  });

  it("returns a timeline capped at 500, oldest-first", () => {
    const { timeline } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.length).toBeLessThanOrEqual(500);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].timestamp).toBeGreaterThanOrEqual(timeline[i - 1].timestamp);
    }
  });
});

describe("getSessionAnalytics (JOIN rewrite)", () => {
  beforeAll(seed);

  it("aggregates tokens, cost and tool_count per session", () => {
    const rows = getSessionAnalytics(T0 - 1000, T0 + 10 * 86400000, "started_at", "desc", 20, 0);
    const s1 = rows.find(r => r.session_id === "s1")!;
    expect(s1.total_tokens).toBe(150);
    expect(s1.cost).toBeCloseTo(1.25);
    expect(s1.tool_count).toBe(4); // tool_call events: Read×2 + Bash×1 + Glob×1
  });

  it("sorts by computed columns", () => {
    const rows = getSessionAnalytics(T0 - 1000, T0 + 10 * 86400000, "cost", "desc", 20, 0);
    expect(rows[0].session_id).toBe("s1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** on avg_duration (old code pairs Read r1's call with BOTH later results, giving a different average) or simply to establish red. `npx vitest run src/lib/__tests__/analytics-queries.test.ts`

- [ ] **Step 3: Replace `getToolAnalytics` body** (db.ts:997-1061) with the profiled single-pass version:

```typescript
export function getToolAnalytics(from: number, to: number, provider?: DbProvider): import("@/types").ToolAnalytics {
  const d = getDb();
  const eP = pSql("provider", provider);
  const pa = pArg(provider);

  const tools = d.prepare(`
    SELECT
      tool_name,
      COUNT(*) as call_count,
      COUNT(*) as success_count,
      0 as failure_count,
      100.0 as success_rate,
      0 as avg_duration_ms
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all(from, to, ...pa) as import("@/types").ToolAnalyticEntry[];

  // One grouped scan for failures (SQLite LIKE is already case-insensitive
  // for ASCII, so two patterns cover error/Error/FAIL/fail).
  const failureRows = d.prepare(`
    SELECT tool_name, COUNT(*) as cnt FROM agent_events
    WHERE event_type = 'tool_result' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
      AND (summary LIKE '%error%' OR summary LIKE '%fail%')
    GROUP BY tool_name
  `).all(from, to, ...pa) as { tool_name: string; cnt: number }[];
  const failures = new Map(failureRows.map(r => [r.tool_name, r.cnt]));

  // One window-function pass for durations: pair each tool_result with the
  // nearest PRECEDING tool_call of the same (agent, tool) within 300s. The
  // old per-tool self-join was O(n²) per tool (6.1s at 58K events); this is
  // a single ordered scan (~80ms) and pairs calls/results more accurately.
  const durationRows = d.prepare(`
    WITH seq AS (
      SELECT tool_name, event_type, timestamp,
        LAG(event_type) OVER w AS prev_type,
        LAG(timestamp) OVER w AS prev_ts
      FROM agent_events
      WHERE event_type IN ('tool_call','tool_result') AND tool_name IS NOT NULL
        AND timestamp >= ? AND timestamp < ?${eP}
      WINDOW w AS (PARTITION BY agent_id, tool_name ORDER BY timestamp)
    )
    SELECT tool_name, AVG(timestamp - prev_ts) AS avg_ms
    FROM seq
    WHERE event_type = 'tool_result' AND prev_type = 'tool_call'
      AND timestamp - prev_ts BETWEEN 0 AND 300000
    GROUP BY tool_name
  `).all(from, to, ...pa) as { tool_name: string; avg_ms: number | null }[];
  const durations = new Map(durationRows.map(r => [r.tool_name, r.avg_ms]));

  for (const tool of tools) {
    tool.failure_count = failures.get(tool.tool_name) ?? 0;
    tool.success_count = tool.call_count - tool.failure_count;
    tool.success_rate = tool.call_count > 0
      ? Math.round((tool.success_count / tool.call_count) * 1000) / 10
      : 100;
    tool.avg_duration_ms = Math.round(durations.get(tool.tool_name) ?? 0);
  }

  const timeline = d.prepare(`
    SELECT
      tool_name,
      timestamp,
      1 as success,
      0 as duration_ms
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(from, to, ...pa) as import("@/types").ToolTimelinePoint[];

  return { tools, timeline: timeline.reverse() };
}
```

- [ ] **Step 4: Replace `getSessionAnalytics` body** (db.ts:967-995) — correlated subqueries → grouped LEFT JOINs (verified row-identical on live data):

```typescript
export function getSessionAnalytics(from: number, to: number, sort = "started_at", order = "desc", limit = 20, offset = 0, provider?: DbProvider): import("@/types").SessionAnalyticRow[] {
  const d = getDb();
  const validSorts: Record<string, string> = {
    started_at: "s.started_at",
    cost: "cost",
    duration: "duration_ms",
    tokens: "total_tokens",
  };
  const sortCol = validSorts[sort] || "s.started_at";
  const sortOrder = order === "asc" ? "ASC" : "DESC";

  return d.prepare(`
    SELECT
      s.id as session_id,
      s.project,
      s.entrypoint,
      s.status,
      s.provider,
      (COALESCE(s.ended_at, ?) - s.started_at) as duration_ms,
      COALESCE(tu.total_tokens, 0) as total_tokens,
      COALESCE(tu.cost, 0) as cost,
      COALESCE(ec.tool_count, 0) as tool_count,
      s.started_at
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, SUM(input_tokens + output_tokens) AS total_tokens, SUM(cost) AS cost
      FROM token_usage GROUP BY session_id
    ) tu ON tu.session_id = s.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS tool_count
      FROM agent_events WHERE event_type = 'tool_call' GROUP BY session_id
    ) ec ON ec.session_id = s.id
    WHERE s.started_at >= ? AND s.started_at < ?${pSql("s.provider", provider)}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(Date.now(), from, to, ...pArg(provider), limit, offset) as import("@/types").SessionAnalyticRow[];
}
```

- [ ] **Step 5: Run new tests + full suite — expect PASS.** `npx vitest run`

- [ ] **Step 6: Commit** — `perf(db): single-pass tool analytics + JOIN session analytics (7.2s→<0.2s, 1.7s→<50ms)`

---

### Task 3: SQLite pragmas, composite indexes, cached prepared statements

**Files:**
- Modify: `src/lib/db.ts` (getDb pragmas + index DDL at :81-89; add `prep()` helper; mechanically switch constant-SQL `getDb().prepare(...)`/`d.prepare(...)` call sites to `prep(...)`)
- Test: `src/lib/__tests__/schema.test.ts` (extend)

**Interfaces:**
- Produces: internal `prep(sql: string): Database.Statement` — cached per open DB. Dynamic SQL (template-built WHERE/SET clauses in `updateSession`, `updateAgent`, `listAgents`, `listEvents`, `listSessionEvents`, `listSessions`, `getMonitorStats`, and every function using `pSql(...)` interpolation) **keeps using `.prepare()` directly** — only byte-constant SQL moves to `prep()`.

- [ ] **Step 1: Extend schema test (failing first)** — add to `src/lib/__tests__/schema.test.ts`:

```typescript
it("sets performance pragmas", () => {
  const d = getDb();
  expect(d.pragma("busy_timeout", { simple: true })).toBe(5000);
  expect(d.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
});

it("has composite hot-path indexes", () => {
  const d = getDb();
  const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(r => r.name);
  expect(names).toContain("idx_events_agent_ts");
  expect(names).toContain("idx_events_session_ts");
  expect(names).toContain("idx_agents_parent");
});
```

- [ ] **Step 2: Run — expect FAIL**, then implement in `getDb()`:

After `db.pragma("foreign_keys = ON");` (db.ts:20):

```typescript
  // WAL + NORMAL is durable against corruption (a crash can only lose the
  // last few commits, never corrupt); FULL fsyncs every commit for no benefit
  // in a usage tracker. busy_timeout covers writer overlap (events POST vs
  // codex watcher) instead of throwing SQLITE_BUSY.
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
```

In the index DDL block (db.ts:81-89) add:

```sql
    CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON agent_events(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_session_ts ON agent_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
```

- [ ] **Step 3: Add the statement cache** — near the top of db.ts (after `let db: ... = null;`):

```typescript
// Compiled-statement cache. better-sqlite3 re-parses SQL on every .prepare(),
// which the event-ingest hot path hits ~8× per hook event. Keyed per open DB:
// getDb() re-creates the Map when it (re)opens, and vi.resetModules() in tests
// resets both together.
let stmtCache = new Map<string, Database.Statement>();

function prep(sql: string): Database.Statement {
  const d = getDb();
  let s = stmtCache.get(sql);
  if (!s) {
    s = d.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}
```

Inside `getDb()` right after `db = new Database(getDbPath());` add: `stmtCache = new Map();`

Then mechanically convert **constant-SQL** call sites to `prep(...)`: `getSession`, `ensureSession`'s touch UPDATE, `createSession`, `createAgent`, `getAgent`, `getAgentChildren`, `getMainAgent`, `getWorkingSubagents`, `createEvent` (two constant variants keyed by the interpolated verb string — the template literal is fine, both strings cache), `getRecentEvents`, `getLatestEvent`, `upsertTokenUsage`, `getSessionTokenUsage`, `getTotalCost`, `getCodexIngest`, `upsertCodexIngest`, `getSessionAgents`, `getSetting`, `setSetting`, `completeSessionAgents`, `deleteBefore`'s four statements, `previewPurge`, `clearAllMonitorData`, `abandonStaleSessions`, `archiveStaleAgents`, `rollupDailyUsageRange`'s three statements. Functions that interpolate `pSql(...)`/dynamic fields keep `.prepare()`.

- [ ] **Step 4: Run full suite — expect PASS.** `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit** — `perf(db): busy_timeout+synchronous pragmas, composite indexes, cached prepared statements`

---

### Task 4: Deduplicate the per-request daily rollups

Every 60s analytics refresh fires **3 rollups** (overview → `rollupDailyUsage()`, trends + models → `rollupDailyUsageRange(from,to)` with identical args) — each a multi-table range scan + upsert transaction. Throttle identical rollup ranges to once per 60s, preserving coverage semantics exactly.

**Files:**
- Modify: `src/lib/db.ts` (add `maybeRollupRange`), `src/app/api/analytics/overview/route.ts:16`, `src/app/api/analytics/trends/route.ts:18`, `src/app/api/analytics/models/route.ts:16`
- Test: `src/lib/__tests__/analytics-queries.test.ts` (extend)

**Interfaces:**
- Produces: `maybeRollupRange(from: number, to: number, nowMs?: number): boolean` — runs `rollupRangeChunked(from, to)` and returns true unless the same `(from,to)` bucket ran <60s ago (returns false). Bucket key quantizes `to` to the minute so SWR's moving `to=Date.now()` still dedupes.

- [ ] **Step 1: Failing test**

```typescript
describe("maybeRollupRange throttle", () => {
  it("dedupes identical ranges within 60s but allows new ranges", () => {
    const t = Date.parse("2026-07-10T00:00:00Z");
    expect(maybeRollupRange(t, t + 86400000, t + 86400000)).toBe(true);
    expect(maybeRollupRange(t, t + 86400000 + 5_000, t + 86400000 + 5_000)).toBe(false); // same minute bucket
    expect(maybeRollupRange(t, t + 86400000 + 61_000, t + 86400000 + 61_000)).toBe(true); // next minute
    expect(maybeRollupRange(t - 86400000, t + 86400000, t + 86400000)).toBe(true); // different from
  });
});
```

(import `maybeRollupRange` from `@/lib/db` in the existing import block)

- [ ] **Step 2: Implement in db.ts** (below `rollupRangeChunked`):

```typescript
// Analytics routes call this once per request; identical ranges within the
// same minute collapse to one real rollup (the 60s cadence matches the SWR
// refresh interval that generates them).
const rollupSeen = new Map<string, number>();

export function maybeRollupRange(from: number, to: number, nowMs = Date.now()): boolean {
  const key = `${from}|${Math.floor(to / 60_000)}`;
  const last = rollupSeen.get(key) ?? 0;
  if (nowMs - last < 60_000) return false;
  rollupSeen.set(key, nowMs);
  if (rollupSeen.size > 256) {
    // prune stale keys so a long-lived server doesn't accumulate ranges
    for (const [k, ts] of rollupSeen) if (nowMs - ts > 3_600_000) rollupSeen.delete(k);
  }
  rollupRangeChunked(from, to);
  return true;
}
```

Note: `rollupRangeChunked` is currently `function` (not exported) — keep it private; `maybeRollupRange` is the public seam.

- [ ] **Step 3: Point the three routes at it.** In `overview/route.ts` replace `rollupDailyUsage();` with `maybeRollupRange(from, to);` (it already parses `from`/`to` — confirm order: parse params first, then rollup). In `trends/route.ts` and `models/route.ts` replace `rollupDailyUsageRange(from, to);` with `maybeRollupRange(from, to);`. Update imports accordingly (remove now-unused `rollupDailyUsage`/`rollupDailyUsageRange` imports; `rollupDailyUsage` stays exported for the events route).

- [ ] **Step 4: Run full suite + tsc — PASS.** `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit** — `perf(analytics): throttle duplicate daily rollups to one per range per minute`

---

### Task 5: Provider layer — cached keychain token, TTL usage cache, parallel health

`readClaudeCodeOAuthToken` spawns `execSync("whoami")` + `execSync("security …")` on **every** `/api/usage/claude` and `/api/health` call (blocking the event loop); `/api/health` then awaits Claude → OpenAI **serially** and re-does what the usage routes just did (measured 1.43s).

**Files:**
- Create: `src/lib/ttl-cache.ts`
- Modify: `src/lib/providers/claude-client.ts:94-113` (token caching, no subprocess for username), `src/app/api/usage/claude/route.ts`, `src/app/api/usage/openai/route.ts`, `src/app/api/health/route.ts`
- Test: `src/lib/__tests__/ttl-cache.test.ts`

**Interfaces:**
- Produces: `ttlCache<T>(ttlMs: number)` → `{ get(key: string, compute: () => Promise<T>): Promise<T>, invalidate(key: string): void }`. Concurrent `get`s for the same key share one in-flight promise; rejected promises are not cached.
- `ClaudeClient.readClaudeCodeOAuthToken()` keeps its signature (sync, string|null) but memoizes for 5 minutes and uses `os.userInfo().username` instead of `whoami`.
- Usage routes + health share caches keyed `"claude"` / `"openai"` with **30s TTL** — health reuses a warm usage fetch instead of re-hitting SaaS.

- [ ] **Step 1: Failing tests**

```typescript
// src/lib/__tests__/ttl-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import { ttlCache } from "@/lib/ttl-cache";

describe("ttlCache", () => {
  it("computes once within TTL and shares in-flight promises", async () => {
    const cache = ttlCache<number>(10_000);
    const compute = vi.fn(async () => 42);
    const [a, b] = await Promise.all([cache.get("k", compute), cache.get("k", compute)]);
    expect(a).toBe(42); expect(b).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after TTL expiry", async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    const compute = vi.fn(async () => 1);
    await cache.get("k", compute);
    vi.advanceTimersByTime(1_500);
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not cache rejections", async () => {
    const cache = ttlCache<number>(10_000);
    let n = 0;
    const compute = async () => { n++; if (n === 1) throw new Error("boom"); return 7; };
    await expect(cache.get("k", compute)).rejects.toThrow("boom");
    await expect(cache.get("k", compute)).resolves.toBe(7);
  });

  it("invalidate forces recompute", async () => {
    const cache = ttlCache<number>(10_000);
    const compute = vi.fn(async () => 5);
    await cache.get("k", compute);
    cache.invalidate("k");
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Implement `src/lib/ttl-cache.ts`**

```typescript
// Tiny promise-aware TTL memo. One in-flight compute per key; failures are
// never cached so a transient upstream error doesn't stick for the TTL.
type Entry<T> = { at: number; promise: Promise<T> };

export function ttlCache<T>(ttlMs: number) {
  const entries = new Map<string, Entry<T>>();
  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
      const promise = compute().catch((err) => {
        entries.delete(key); // don't cache failures
        throw err;
      });
      entries.set(key, { at: Date.now(), promise });
      return promise;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
  };
}
```

- [ ] **Step 3: Cache the keychain token** in `claude-client.ts` — replace lines 94-113:

```typescript
  /**
   * Try to read Claude Code's OAuth token from the macOS Keychain.
   * Returns the access token or null if not found.
   *
   * Memoized for 5 minutes: `security` forks a subprocess and hits the
   * Keychain — doing that on every 60s usage poll (and every health check)
   * stalls the event loop for no benefit. A failed/absent token also caches
   * (as null) so a machine without Claude Code isn't re-probed per request.
   */
  private static tokenCache: { value: string | null; at: number } | null = null;
  private static readonly TOKEN_TTL_MS = 5 * 60 * 1000;

  static readClaudeCodeOAuthToken(): string | null {
    const cached = ClaudeClient.tokenCache;
    if (cached && Date.now() - cached.at < ClaudeClient.TOKEN_TTL_MS) return cached.value;
    const value = ClaudeClient.readTokenUncached();
    ClaudeClient.tokenCache = { value, at: Date.now() };
    return value;
  }

  /** Drop the cached token (e.g. after an auth failure) so the next read re-probes. */
  static invalidateTokenCache(): void {
    ClaudeClient.tokenCache = null;
  }

  private static readTokenUncached(): string | null {
    try {
      if (process.platform !== "darwin") return null;

      const username = userInfo().username;
      const raw = execSync(
        `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();

      const creds = JSON.parse(raw);
      const token = creds?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token.startsWith("sk-ant-oat")) {
        return token;
      }
      return null;
    } catch {
      return null;
    }
  }
```

Add `import { userInfo } from "os";` at the top. In `fetchUsage()` (line 140-150), when the OAuth attempt throws, call `ClaudeClient.invalidateTokenCache();` before falling back to the session key.

- [ ] **Step 4: Shared usage caches.** Create module-level caches and use them in all three routes.

In `src/app/api/usage/claude/route.ts` — wrap the existing fetch logic body: the route currently constructs a client and calls `fetchUsage()`; wrap exactly that call as `claudeUsageCache.get("claude", () => client.fetchUsage())`. Export nothing new. Add at top:

```typescript
import { ttlCache } from "@/lib/ttl-cache";
import type { ClaudeUsageData } from "@/types";

// 30s: long enough that /api/health (5min cadence) and a dashboard refresh
// share one upstream call, short enough that the 60s poll always refetches.
export const claudeUsageCache = ttlCache<ClaudeUsageData>(30_000);
```

Mirror in `src/app/api/usage/openai/route.ts` with `export const openaiUsageCache = ttlCache<OpenAIUsageData>(30_000);` wrapping its `fetchUsage()`.

(Adjust to each route's actual structure — read the file first; keep response shapes identical.)

- [ ] **Step 5: Health route — parallel + cache-backed.** Replace the two sequential try-blocks in `src/app/api/health/route.ts` with:

```typescript
  const [claudeResult, openaiResult] = await Promise.allSettled([
    (async () => {
      if (!creds.claude?.sessionKey || !creds.claude?.organizationId) throw new Error("No credentials configured");
      await claudeUsageCache.get("claude", () =>
        new ClaudeClient(creds.claude!.sessionKey, creds.claude!.organizationId).fetchUsage()
      );
    })(),
    (async () => {
      const codexAuth = OpenAIClient.readCodexAuth();
      if (!codexAuth) throw new Error("Codex CLI not logged in");
      await openaiUsageCache.get("openai", () =>
        new OpenAIClient(codexAuth.accessToken, codexAuth.accountId).fetchUsage()
      );
    })(),
  ]);
  health.claude.connected = claudeResult.status === "fulfilled";
  if (claudeResult.status === "rejected") health.claude.error = claudeResult.reason instanceof Error ? claudeResult.reason.message : "Unknown error";
  health.openai.connected = openaiResult.status === "fulfilled";
  if (openaiResult.status === "rejected") health.openai.error = openaiResult.reason instanceof Error ? openaiResult.reason.message : "Unknown error";
```

Import the two caches from the usage routes (`import { claudeUsageCache } from "@/app/api/usage/claude/route";` — Next.js route files may export non-handler symbols only if not conflicting with route conventions; **if `next build` complains about extra route exports, move both caches into `src/lib/providers/usage-cache.ts` and import from there in all three routes** — prefer that shared-module layout from the start).

**Decision locked in:** create `src/lib/providers/usage-cache.ts` exporting both caches; routes import from it. Route files export only HTTP handlers.

```typescript
// src/lib/providers/usage-cache.ts
import { ttlCache } from "@/lib/ttl-cache";
import type { ClaudeUsageData, OpenAIUsageData } from "@/types";

// 30s: /api/health and a dashboard refresh share one upstream call; the 60s
// usage poll always refetches.
export const claudeUsageCache = ttlCache<ClaudeUsageData>(30_000);
export const openaiUsageCache = ttlCache<OpenAIUsageData>(30_000);
```

- [ ] **Step 6: Run suite + tsc — PASS**, then `npx eslint .` (only the one pre-existing error may remain).

- [ ] **Step 7: Commit** — `perf(providers): cache keychain token 5min + share 30s usage cache, parallelize health`

---

### Task 6: Codex watcher — stop full-tree rescans every 4s

`pollOnce` walks all of `~/.codex/sessions` (recursive `readdirSync` + `statSync`) every 4 seconds on the serving event loop — worst over Docker's VirtioFS bind mount. New sessions only ever appear under **today's** `YYYY/MM/DD` directory, so scan that cheaply each tick and do the full walk once a minute.

**Files:**
- Modify: `src/lib/providers/codex-watcher.ts`
- Test: `src/lib/__tests__/codex-watcher-scan.test.ts` (new; the existing `codex-rollout.test.ts`/`codex-ingest.test.ts` must stay green)

**Interfaces:**
- Produces: exported pure helper `scanDirsForTick(nowMs: number, lastFullScanMs: number): "full" | string[]` — returns `"full"` when a full walk is due (≥60s since last), else the **relative** day-dir paths to scan (today, plus yesterday within the first hour after local midnight).
- `discoverRolloutFiles(sessionsDir, sinceMs)` keeps its signature (used by `pollOnce` full path).

- [ ] **Step 1: Failing tests**

```typescript
// src/lib/__tests__/codex-watcher-scan.test.ts
import { describe, it, expect } from "vitest";
import { scanDirsForTick } from "@/lib/providers/codex-watcher";

function localDayDir(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

describe("scanDirsForTick", () => {
  it("requests a full walk when 60s have passed", () => {
    const now = Date.parse("2026-07-14T12:00:00");
    expect(scanDirsForTick(now, now - 61_000)).toBe("full");
  });

  it("scans only today's dir between full walks", () => {
    const now = new Date("2026-07-14T12:00:00").getTime();
    expect(scanDirsForTick(now, now - 4_000)).toEqual([localDayDir(new Date(now))]);
  });

  it("includes yesterday within the first hour after midnight", () => {
    const now = new Date("2026-07-14T00:30:00").getTime();
    const dirs = scanDirsForTick(now, now - 4_000) as string[];
    expect(dirs).toContain(localDayDir(new Date(now)));
    expect(dirs).toContain(localDayDir(new Date(now - 86400000)));
  });
});
```

- [ ] **Step 2: Implement.** In `codex-watcher.ts`:

```typescript
const FULL_SCAN_INTERVAL_MS = 60_000;

// Which directories does this tick need? New rollout files are always created
// under today's YYYY/MM/DD dir, so between full walks (every 60s, catching
// clock skew / unusual layouts) a tick only lists today — and yesterday for
// the first hour after midnight, when a pre-midnight session is still active.
export function scanDirsForTick(nowMs: number, lastFullScanMs: number): "full" | string[] {
  if (nowMs - lastFullScanMs >= FULL_SCAN_INTERVAL_MS) return "full";
  const dirs: string[] = [];
  const day = (d: Date) =>
    `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date(nowMs);
  dirs.push(day(now));
  if (now.getHours() === 0) dirs.push(day(new Date(nowMs - 86400000)));
  return dirs;
}
```

Rework `pollOnce` to accept the file list and keep a module-scoped known-file cache in `startCodexWatcher`:

```typescript
export function pollOnce(sessionsDir: string, sinceMs = 0, opts?: { broadcast?: boolean; files?: string[] }): number {
  const broadcast = opts?.broadcast ?? false;
  const files = opts?.files ?? discoverRolloutFiles(sessionsDir, sinceMs);

  let inserted = 0;
  for (const file of files) {
    // ... existing body unchanged ...
  }
  // ... existing closeIdleCodexSessions block unchanged ...
  return inserted;
}
```

And in the interval callback inside `startCodexWatcher`:

```typescript
  let lastFullScan = 0;
  let knownFiles: string[] = [];

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      const plan = scanDirsForTick(Date.now(), lastFullScan);
      if (plan === "full") {
        lastFullScan = Date.now();
        knownFiles = discoverRolloutFiles(sessionsDir, since);
        pollOnce(sessionsDir, since, { broadcast: true, files: knownFiles });
      } else {
        const todays = plan.flatMap((rel) => discoverRolloutFiles(join(sessionsDir, rel), since));
        // union with the known set so an already-discovered but still-active
        // older file keeps getting tailed between full walks
        const union = Array.from(new Set([...knownFiles, ...todays]));
        knownFiles = union;
        pollOnce(sessionsDir, since, { broadcast: true, files: union });
      }
    } catch (err) {
      console.error("[codex-watcher] poll failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
```

(`discoverRolloutFiles` on a nonexistent day-dir returns `[]` because `walk` swallows the readdir error — no guard needed. The boot backfill line stays as-is: one full discover at startup.)

- [ ] **Step 3: Run suite — all green including existing codex tests.** `npx vitest run`

- [ ] **Step 4: Commit** — `perf(codex): tick-scan only today's rollout dir; full tree walk once a minute`

---

### Task 7: SSE — serialize each broadcast once

`stream/route.ts:20` runs `JSON.stringify(event)` inside **every connection's** listener. Serialize (and UTF-8 encode) once per event in `broadcastEvent`.

**Files:**
- Modify: `src/lib/ws.ts`, `src/app/api/monitor/stream/route.ts`
- Test: `src/lib/__tests__/ws.test.ts` (new)

**Interfaces:**
- `broadcastEvent(event: WsEvent)` signature unchanged (all API routes keep calling it with objects).
- `addListener(fn: (frame: Uint8Array) => void)` — listeners now receive the **pre-encoded SSE frame bytes** (`event: message\ndata: {...}\n\n`).

- [ ] **Step 1: Failing test**

```typescript
// src/lib/__tests__/ws.test.ts
import { describe, it, expect } from "vitest";
import { broadcastEvent, addListener, getListenerCount } from "@/lib/ws";

describe("ws broadcast", () => {
  it("delivers one pre-encoded SSE frame to every listener", () => {
    const got: Uint8Array[] = [];
    const un1 = addListener((f) => got.push(f));
    const un2 = addListener((f) => got.push(f));
    broadcastEvent({ type: "stats_updated", data: { n: 1 } });
    expect(got).toHaveLength(2);
    expect(got[0]).toBe(got[1]); // same frame object — encoded exactly once
    const text = new TextDecoder().decode(got[0]);
    expect(text).toBe(`event: message\ndata: {"type":"stats_updated","data":{"n":1}}\n\n`);
    un1(); un2();
    expect(getListenerCount()).toBe(0);
  });

  it("keeps delivering when one listener throws", () => {
    const got: Uint8Array[] = [];
    const unBad = addListener(() => { throw new Error("dead client"); });
    const unGood = addListener((f) => got.push(f));
    broadcastEvent({ type: "stats_updated", data: {} });
    expect(got).toHaveLength(1);
    unBad(); unGood();
  });
});
```

- [ ] **Step 2: Implement.** `src/lib/ws.ts` — keep the type union, change the plumbing:

```typescript
type Listener = (frame: Uint8Array) => void;

const listeners = new Set<Listener>();
const encoder = new TextEncoder();

export function broadcastEvent(event: WsEvent): void {
  if (listeners.size === 0) return; // nobody connected — skip the stringify entirely
  const frame = encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch {
      // ignore listener errors
    }
  }
}
```

`src/app/api/monitor/stream/route.ts` — the listener becomes a straight enqueue:

```typescript
      const unsubscribe = addListener((frame) => {
        try {
          controller.enqueue(frame);
        } catch {
          // controller may be closed
        }
      });
```

- [ ] **Step 3: Run suite + tsc — PASS.**

- [ ] **Step 4: Commit** — `perf(sse): encode each broadcast frame once, not per connection`

---

### Task 8: Monitor frontend — memoize cards, cap event arrays, pause the hidden tick

The dominant idle cost: every second `useNow` re-renders every `AgentCard`, each re-running `[...events].reverse().find`, `filter`, and a per-event `JSON.parse` loop (up to 200 events × N cards × 1/s); every SSE event re-renders the whole panel; the per-agent events map grows unboundedly; four derived memos are computed and never consumed.

**Files:**
- Modify: `src/hooks/use-agent-monitor.ts`, `src/hooks/use-now.ts`, `src/components/monitor/AgentCard.tsx`, `src/components/monitor/AgentMonitorPanel.tsx`
- Test: none new (no jsdom test env in this repo) — gate: `npx tsc --noEmit && npx eslint . && npx vitest run` (eslint must be **0 errors** after this task) + runtime verification in the Verify phase.

**Interfaces:**
- `useAgentMonitor()` return shape: **removes** `completedAgents`, `mainAgents`, `subagents`, `sessionGroups` (verified unused anywhere: `grep -rn "completedAgents\|mainAgents\|subagents\|sessionGroups" src/ --include="*.tsx" --include="*.ts"` must show only the hook itself before deleting — if a consumer exists, keep that one and delete the rest).
- `useNow()` semantics unchanged for visible tabs; when `document.hidden` the shared interval stops (re-render storm stops) and a fresh tick fires on becoming visible.

- [ ] **Step 1: use-agent-monitor.ts changes** (all in one edit):

1. Cap per-agent arrays at insert (SSE `event_created` handler):

```typescript
          setEvents((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.agent_id) || [];
            // cap per-agent history: AgentCard renders at most 200 anyway,
            // and an uncapped array is an unbounded memory leak on long runs
            const appended = existing.length >= 200
              ? [...existing.slice(existing.length - 199), event]
              : [...existing, event];
            next.set(event.agent_id, appended);
            return next;
          });
```

2. Replace the provider-reset effect (lines 36-40, the eslint error) with a reset-inside-setter:

```typescript
  const setProviderAndReset = useCallback((p: ProviderFilterValue) => {
    setProvider(p);
    // Switching provider must drop the merge-only caches, or agents from the
    // tab you just left would linger (SWR onSuccess and SSE both only add).
    setAgents(new Map());
    setEvents(new Map());
    setRecentActivity([]);
  }, []);
```

Delete the `useEffect` at :36-40, return `setProvider: setProviderAndReset` from the hook (keep the external name `setProvider`).

3. Delete the unused derived memos `completedAgents`, `mainAgents`, `subagents`, `sessionGroups` and their return entries (after the grep check above). Derive `workingAgents`/`idleAgents` in one pass:

```typescript
  const { workingAgents, idleAgents } = useMemo(() => {
    const working: AgentRecord[] = [];
    const idle: AgentRecord[] = [];
    for (const a of agentList) {
      if (a.status === "working") working.push(a);
      else if (a.status === "idle") idle.push(a);
    }
    return { workingAgents: working, idleAgents: idle };
  }, [agentList]);
```

4. Relax the reconcile polls: change the three `refreshInterval: 30_000` to `refreshInterval: 60_000` (SSE is the live channel; the poll is a reconcile net).

- [ ] **Step 2: use-now.ts — pause while hidden.** Current file keeps one shared `setInterval(1000)` always running. Rework the subscribe path (keep `useSyncExternalStore` + second-quantized snapshot):

```typescript
function startTicking() {
  if (timer !== null) return;
  timer = setInterval(notify, 1000);
}

function stopTicking() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function handleVisibility() {
  if (document.hidden) {
    stopTicking();
  } else {
    notify(); // immediate catch-up tick so "Xs ago" text is right on return
    startTicking();
  }
}
```

Wire `document.addEventListener("visibilitychange", handleVisibility)` when the first subscriber arrives and remove it (plus `stopTicking()`) when the last unsubscribes. Adapt names to the file's actual structure — read it first; keep the exported `useNow()` signature identical.

- [ ] **Step 3: AgentCard.tsx — memoize the per-event derivations and the component.** Wrap the three derivations (lines ~77-84: `latestToolCall` via `[...events].reverse().find(...)`, the `toolCalls` filter, the `allFiles` JSON.parse loop) in one `useMemo(() => {...}, [events])` returning `{ latestToolCall, toolCalls, allFiles }`. Then export the component wrapped: `export const AgentCard = memo(AgentCardImpl);` (match the file's current export style — default vs named — and update imports if needed). The `useNow` tick still re-renders the card (elapsed text must update) but no longer re-parses JSON.

- [ ] **Step 4: AgentMonitorPanel.tsx**

1. Memoize + stabilize the per-agent events slice passed to cards. Replace the inline `events={(events.get(agent.id) || []).slice(0, 200)}` with a lookup into a memoized map:

```typescript
  const EMPTY_EVENTS: AgentEvent[] = useMemo(() => [], []);
  // events arrays are already capped at 200 in the hook, so pass them through
  // by identity — a fresh .slice() per render would defeat AgentCard's memo
  const eventsFor = useCallback(
    (id: string) => events.get(id) ?? EMPTY_EVENTS,
    [events, EMPTY_EVENTS]
  );
```

…and use `events={eventsFor(agent.id)}`.

2. Wrap `ActivityItem` and `SessionCard` in `React.memo` (they're defined in this file at ~:66 and ~:91).

3. Gate `filteredAgents` (lines ~181-199) on the active tab: `const filteredAgents = useMemo(() => { if (viewMode !== "agents") return EMPTY_AGENTS; ...existing logic... }, [agents, viewMode, ...existing deps]);` with a stable `EMPTY_AGENTS` constant.

- [ ] **Step 5: Gate — `npx tsc --noEmit && npx eslint . && npx vitest run`.** eslint: **0 problems** (the set-state-in-effect error is gone with the effect). Then `npm run build` must succeed.

- [ ] **Step 6: Commit** — `perf(monitor): memoize cards+derivations, cap event arrays, pause hidden tick, fix provider-reset lint`

---

### Task 9: Analytics frontend — fetch only the active tab, fix Refresh key, single-pass panels

All 7 analytics endpoints are fetched and re-polled every 60s even though 5 sit behind inactive tabs; the manual Refresh button revalidates a dead SWR key (`/api/usage/antigravity`) so the OpenAI card never refreshes; panels do O(n×m) filtering per render.

**Files:**
- Modify: `src/hooks/use-analytics.ts`, `src/app/analytics/page.tsx`, `src/components/dashboard/RefreshControl.tsx:11-15`, `src/components/analytics/ToolsPanel.tsx`, `src/components/analytics/ModelsPanel.tsx`
- Test: gate via `tsc`/`eslint`/`build` + Verify phase (no component test env).

**Interfaces:**
- `useAnalytics(activeTab: AnalyticsTab)` — new required param; `type AnalyticsTab = "insights" | "sessions" | "tools" | "files" | "models"` exported from the hook. `overview` + `trends` always fetch; each tab dataset fetches only while its tab is active (SWR key `null` otherwise → no fetch, no polling). Return shape unchanged.
- `app/analytics/page.tsx` owns `activeTab` state already — move the `useState` **above** the hook call and pass it in.

- [ ] **Step 1: use-analytics.ts** — add the param and conditional keys:

```typescript
export type AnalyticsTab = "insights" | "sessions" | "tools" | "files" | "models";

export function useAnalytics(activeTab: AnalyticsTab) {
  // ... existing state ...
  const tabKey = (tab: AnalyticsTab, url: string) => (activeTab === tab ? url : null);

  const { data: sessions, isLoading: sessionsLoading } = useSWR<SessionAnalyticRow[]>(
    tabKey("sessions", `/api/analytics/sessions?${params}&sort=${sessionSort.sort}&order=${sessionSort.order}&limit=20&offset=${sessionPage * 20}`),
    fetcher, swrOpts
  );

  const { data: toolAnalytics, isLoading: toolsLoading } = useSWR<ToolAnalytics>(
    tabKey("tools", `/api/analytics/tools?${params}`), fetcher, swrOpts
  );

  const { data: fileAnalytics, isLoading: filesLoading } = useSWR<FileAnalytics>(
    tabKey("files", `/api/analytics/files?${params}`), fetcher, swrOpts
  );

  const { data: modelAnalytics, isLoading: modelsLoading } = useSWR<ModelAnalytics>(
    tabKey("models", `/api/analytics/models?${params}`), fetcher, swrOpts
  );

  const { data: insights, isLoading: insightsLoading } = useSWR<UsageInsights>(
    tabKey("insights", `/api/analytics/insights?${params}`), fetcher, swrOpts
  );
  // overview + trends keep unconditional keys
```

- [ ] **Step 2: page.tsx** — hoist the existing `activeTab` state above the hook, pass it to `useAnalytics(activeTab)`, and type it with the exported `AnalyticsTab`. (Read the file first; keep tab-button rendering as-is.)

- [ ] **Step 3: RefreshControl.tsx** — replace the dead key:

```typescript
      mutate("/api/usage/claude");
      mutate("/api/usage/openai");
      mutate("/api/health");
```

(remove `/api/usage/antigravity` entirely.)

- [ ] **Step 4: ToolsPanel.tsx** — replace the per-tool `timeline.filter` (lines ~63-68) with one grouping pass:

```typescript
  const timelineByTool = useMemo(() => {
    const map = new Map<string, ToolTimelinePoint[]>();
    for (const p of timeline) {
      const list = map.get(p.tool_name);
      if (list) list.push(p); else map.set(p.tool_name, [p]);
    }
    return map;
  }, [timeline]);
```

and replace `Math.max(...arr)`/`Math.min(...arr)` spreads over timeline-sized arrays with `arr.reduce((m, v) => (v > m ? v : m), -Infinity)` / mirrored for min (exact shape depends on current code — read lines ~55-70 first).

- [ ] **Step 5: ModelsPanel.tsx** — build `Map<date, ModelTrendPoint[]>` once via `useMemo` on `[trend]` and use `.get(date)` in both places that currently `trend.filter(t => t.date === d)` (lines ~48-53 and ~146-167).

- [ ] **Step 6: Gate — `npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`.** Verify in the build output that switching analytics tabs is the only thing that fetches tab data (checked live in the Verify phase).

- [ ] **Step 7: Commit** — `perf(analytics): lazy per-tab fetching, fix dead Refresh key, single-pass panel grouping`

---

### Task 10: Electron startup — instant window, cheap probe, no login shell first

Startup currently blocks window creation behind a Docker probe of the heavy `/api/health` (up to 7.5s), `waitForServer` polls that same endpoint at 1s granularity, and `findSystemNode` tries a **login zsh** before well-known paths.

**Files:**
- Modify: `electron/main.ts`
- Test: `npm run electron:compile` must pass; behavior validated in the Electron Validate phase.

**Interfaces:**
- Consumes: `GET /api/live` from Task 1.
- `createWindow()` becomes `createWindow(initialUrl: string)`; a module-level `showSplash(win)` loads an inline dark splash immediately.

- [ ] **Step 1: Point probes at `/api/live`.**
  - `dockerServerHealthy` (line 111): `fetch(`http://127.0.0.1:${DOCKER_PORT}/api/live`, …)` — keep the `[1500, 3000, 3000]` retry ladder (cold container boots still need it; the endpoint is now load-independent so attempt 1 nearly always decides).
  - `waitForServer` (line 74): fetch `/api/live` and poll every **250ms**: `await new Promise((r) => setTimeout(r, 250));`

- [ ] **Step 2: Window-first startup.** Restructure `app.on("ready", …)` (lines 443-481):

```typescript
    // Show the window immediately with an inline splash — the Docker probe
    // and (worst case) an embedded-server boot happen behind it, not before it.
    createWindow(SPLASH_URL);
    createTray(mainWindow!, APP_NAME);

    try {
      if (!IS_DEV && (await dockerServerHealthy())) {
        serverMode = "docker";
        serverPort = DOCKER_PORT;
        try {
          if (existsSync(portFilePath())) unlinkSync(portFilePath());
        } catch {
          // stale file is harmless — the hook port-scans before posting
        }
        console.log(`[main] Docker tracker healthy on :${DOCKER_PORT} — thin-client mode (canonical DB)`);
      } else {
        serverMode = IS_DEV ? "dev" : "embedded";
        serverPort = await startServer();
        console.log(`[main] ${serverMode} server running on port ${serverPort}`);
        writeFileSync(portFilePath(), String(serverPort), "utf8");
        console.log(`[main] Port written to ${portFilePath()}`);
      }
    } catch (err) {
      console.error("[main] Failed to start server:", err);
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        `${err instanceof Error ? err.message : String(err)}`
      );
      app.quit();
      return;
    }

    mainWindow?.loadURL(`http://127.0.0.1:${serverPort}`);
```

With, near the top of the file:

```typescript
// Inline splash shown while the server decision happens. Matches the app's
// dark zinc palette so the handoff to the real UI doesn't flash.
const SPLASH_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#09090b;color:#a1a1aa;
  font:14px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;
  align-items:center;justify-content:center;-webkit-user-select:none}
  .wrap{text-align:center}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;
  background:#f59e0b;margin-right:8px;animation:p 1.2s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:.25}50%{opacity:1}}
  </style></head><body><div class="wrap"><span class="dot"></span>Starting LLM Usage Tracker…</div></body></html>`);
```

And `createWindow` takes the URL:

```typescript
function createWindow(initialUrl: string): void {
  // ...existing BrowserWindow options unchanged...
  mainWindow.loadURL(initialUrl);
  // ...rest unchanged...
}
```

Update the `activate` handler's bare `createWindow()` call to `createWindow(\`http://127.0.0.1:${serverPort}\`)`.
**Guard:** in the `did-fail-load` handler, ignore failures for non-`http(s):` URLs (`if (!_url.startsWith("http")) return;` — rename the unused `_url` param to `url`) so the data: splash can never trigger the docker-fallback path.

- [ ] **Step 3: findSystemNode — well-known paths first** (lines 133-153). Reorder so the zsh login shell is the *last* resort:

```typescript
function findSystemNode(): string | null {
  // Well-known locations first — a login zsh (-l) sources the full user
  // profile (nvm/asdf/etc.) and can take seconds; only fall back to it when
  // none of the standard paths exist.
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const probe =
      process.platform === "win32"
        ? execFileSync("where", ["node"], { encoding: "utf8", timeout: 5000 })
        : execFileSync("/bin/zsh", ["-lc", "command -v node"], {
            encoding: "utf8",
            timeout: 5000,
          });
    const found = probe.split("\n")[0].trim();
    if (found && existsSync(found)) return found;
  } catch {
    // no node anywhere
  }
  return null;
}
```

- [ ] **Step 4: Compile + typecheck:** `npm run electron:compile` (clean exit, regenerates `electron/main.js`).

- [ ] **Step 5: Commit** — `perf(electron): window-first startup with splash, /api/live probes, fast node discovery`

---

### Task 11: Packaging — stop shipping the DB/secrets; clean, idempotent builds

The DMG currently packages `.next/standalone/**/*` wholesale — including a 48MB live DB, the real `ENCRYPTION_KEY` in `.env.local`, `credentials.enc.json`, a 639MB nested previous build, and 20MB of TypeScript (751MB standalone → 301MB app → 188MB DMG). The `postbuild` `cp -r` also nests `static/static` on rebuilds.

**Files:**
- Modify: `package.json` (build.files allowlist, scripts), `next.config.ts` (tracing excludes)
- Test: after `npm run electron:build` (run in the Electron Rebuild phase — NOT in this task): package must NOT contain `.data`, `.env.local`, `credentials.enc.json`, `dist-electron`, `node_modules/typescript`; this task's gate is `npm run build && npm run electron:compile` staying green + the file-set assertions below via a dry inspection of globs.

**Interfaces:**
- Consumes: `electron/main.ts` expectations — `app.getAppPath()/.next/standalone/server.js` must exist packaged, plus `.next/standalone/node_modules/better-sqlite3/**` (native module), `electron/*.js`, `.next/standalone/.next/static/**`, `.next/standalone/public/**`.

- [ ] **Step 1: Replace `build.files` in package.json:**

```json
  "files": [
    "electron/**/*.js",
    ".next/standalone/**/*",
    "!.next/standalone/.data{,/**/*}",
    "!.next/standalone/.env*",
    "!.next/standalone/credentials.enc.json",
    "!.next/standalone/dist-electron{,/**/*}",
    "!.next/standalone/node_modules/typescript{,/**/*}",
    "!.next/standalone/docs{,/**/*}",
    "!.next/standalone/src{,/**/*}",
    "!.next/standalone/*.md",
    "!.next/standalone/package-lock.json",
    "!.next/standalone/tsconfig.tsbuildinfo",
    "!dist-electron{,/**/*}"
  ],
```

(Drops the top-level `.next/static/**/*`, `public/**/*`, and `node_modules/better-sqlite3/**/*` globs: the standalone tree already carries all three — static+public via postbuild, better-sqlite3 via Next's file tracing. `electron/main.ts`'s copy-fallback at :208-215 stays as dead-code insurance.)

- [ ] **Step 2: Build scripts** — in package.json `scripts`:

```json
    "electron:build": "npm run electron:clean && npm run build && npm run electron:compile && electron-builder",
    "electron:clean": "rm -rf dist-electron .next",
    "postbuild": "rm -rf .next/standalone/.next/static .next/standalone/public && cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public",
```

(`electron:clean` now wipes all of `.next` — kills the 639MB self-embedding and any stale `.data`/`.env.local` inside standalone at the source. `postbuild` becomes idempotent for `npm run build` outside the clean path.)

- [ ] **Step 3: next.config.ts** — add tracing excludes so `typescript` (20MB, build-only) stops shipping into standalone:

```typescript
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["node_modules/typescript/**"],
  },
};
```

(Merge with the existing config object — read the file first, it currently only sets `output: "standalone"`.)

- [ ] **Step 4: Gate:** `npm run build && npm run electron:compile` both green; `ls .next/standalone/node_modules/typescript` errors (gone); `ls .next/standalone/node_modules/better-sqlite3/build/Release/*.node` exists.

- [ ] **Step 5: Commit** — `fix(build): allowlist packaged files — no DB/secrets/nested builds in the DMG; idempotent postbuild`

---

### Task 12: Hook script — one process instead of five per event

Every Claude Code hook event forks `cat` + up to 3 × `nc` + `python3` + N × `curl` (~5-7 processes); `PreToolUse` **blocks each tool call** on that. Consolidate to a single `python3 -S` process that parses stdin, discovers ports, and POSTs via stdlib http.client.

**Files:**
- Modify: `hooks/agent-monitor-hook.sh` (becomes a thin `exec python3 -S` wrapper), `hooks/register-agent.sh:16`, `hooks/complete-agent.sh:15` (port default 3123 → 3789)
- Create: `hooks/agent-monitor-hook.py`
- Test: `hooks/test-hook.sh` (new, self-contained smoke test run manually in this task)

**Interfaces:**
- Consumes: `POST /api/monitor/events` (unchanged), port file `~/Library/Application Support/llm-usage-tracker/server-port`, env `MONITOR_URL`, `DOCKER_MONITOR_PORT` (default 3789), `CLAUDE_HOOK_TYPE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PROJECT_DIR`.
- Produces: identical POST bodies to today (same event_type mapping for all 7 hook types, same summary/content truncation at 200/2000 chars, same files_affected extraction, same dual-post to every listening instance, same silent-failure guarantees). `~/.claude/settings.json` needs **no change** (same .sh entry point).

- [ ] **Step 1: Write `hooks/agent-monitor-hook.py`** — port the transformation logic **verbatim** from the current inline python (agent-monitor-hook.sh lines 63-180: same event_type mapping, truncations, compaction keywords) and add stdlib port discovery + POST:

```python
#!/usr/bin/env python3 -S
"""Claude Code hook -> LLM Usage Tracker. One process per event: parse stdin,
discover listening tracker instances, POST to each. Never blocks Claude Code:
every failure path exits 0 fast. -S skips site-packages for ~2-3x faster start."""
import http.client
import json
import os
import sys


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


def post_json(host, port, path, body, timeout):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(
            "POST", path, body=body, headers={"Content-Type": "application/json"}
        )
        conn.getresponse().read()
    finally:
        conn.close()


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
        # Explicit override — single target, parse host:port from the URL
        from urllib.parse import urlparse

        u = urlparse(override)
        if u.hostname:
            try:
                post_json(u.hostname, u.port or 80, "/api/monitor/events", body, 5)
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
```

- [ ] **Step 2: Shrink `hooks/agent-monitor-hook.sh`** to a wrapper (keeps `~/.claude/settings.json` untouched):

```bash
#!/usr/bin/env bash
# Claude Code Hook: Agent Monitor — thin wrapper.
# All logic lives in agent-monitor-hook.py (single process per event instead
# of cat+nc+python+curl). Env contract unchanged: MONITOR_URL,
# DOCKER_MONITOR_PORT, CLAUDE_HOOK_TYPE, CLAUDE_CODE_ENTRYPOINT.
exec /usr/bin/env python3 -S "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-monitor-hook.py" 2>/dev/null || exit 0
```

- [ ] **Step 3: Fix helper-script drift:** in `hooks/register-agent.sh:16` and `hooks/complete-agent.sh:15` change the default `MONITOR_PORT` from `3123` to `3789` (read each file first; keep everything else).

- [ ] **Step 4: Smoke-test script `hooks/test-hook.sh`:**

```bash
#!/usr/bin/env bash
# Manual smoke test: send one synthetic event of each hook type at the local
# tracker and verify the script exits 0 fast. Usage: bash hooks/test-hook.sh
set -e
cd "$(dirname "$0")"
for t in PreToolUse PostToolUse Stop SubagentStop SessionStart SessionEnd Notification; do
  START=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo '{"session_id":"hook-smoke-test","tool_name":"Read","tool_input":{"file_path":"/tmp/x"},"cwd":"/tmp/hook-smoke"}' \
    | CLAUDE_HOOK_TYPE="$t" CLAUDE_CODE_ENTRYPOINT=cli bash agent-monitor-hook.sh
  RC=$?
  END=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo "$t: exit=$RC $((END-START))ms"
done
echo "OK — smoke rows land in session hook-smoke-test (retention will age them out)"
```

- [ ] **Step 5: Run the smoke test against the running Docker tracker; every event type must return exit 0 in <300ms and the events must appear via `curl -s "http://127.0.0.1:3789/api/monitor/events/hook-smoke-test" | head -c 400`.** Leave the smoke rows in place (retention ages them out). Do NOT call `/api/monitor/clear` — it would wipe the user's real history.

- [ ] **Step 6: Commit** — `perf(hooks): single-process python hook (1 fork per event instead of ~6); fix helper port drift`

---

### Task 13 (phase): Full verification pass — run by the orchestrator, not a subagent

- [ ] `npx vitest run` — all tests green (≥95 after new tests)
- [ ] `npx tsc --noEmit` — clean; `npx eslint .` — **0 problems**
- [ ] `npm run build` — clean production build
- [ ] Start dev server (`next dev` via launch.json/Browser pane against a scratch `LLM_DATA_DIR`), then:
  - [ ] Exercise every API route (the 24 routes enumerated in CLAUDE.md + `/api/live`) with curl; every response `success:true` (or expected 4xx for bad input)
  - [ ] Load `/`, `/monitor`, `/analytics`, `/settings` in the Browser pane — no console errors, SSE `connected` fires, analytics tabs lazy-load (network shows tab endpoints only after click)
  - [ ] POST synthetic monitor events; confirm they stream live into the Activity feed without full-page refetch storms
- [ ] Timing re-measurement against dev server with production build (`next start`): `/api/analytics/tools` and `/api/analytics/sessions` on the exported Docker data must be dramatically down vs baseline (7.23s / 1.71s). Record numbers for the README.

### Task 14 (phase): Docker rebuild + validation — orchestrator

- [ ] `docker compose up -d --build` (named volume keeps the canonical DB)
- [ ] `docker ps` shows `(healthy)` after start_period (new HEALTHCHECK)
- [ ] Endpoint timing sweep against `:3789` — record before/after table (tools <300ms, sessions <100ms, health <1s warm)
- [ ] `docker logs` — codex-watcher backfill logged, no errors; full-scan cadence visible
- [ ] Live SSE check: `curl -N http://127.0.0.1:3789/api/monitor/stream` receives `connected` + `ping`

### Task 15 (phase): Electron rebuild + validation — orchestrator

- [ ] `npm run electron:build` (now cleans `.next` first, ~includes DMG)
- [ ] Assert package hygiene: `find "dist-electron/mac-arm64/LLM Usage Tracker.app" -name "*.db" -o -name ".env.local" -o -name "credentials.enc.json"` → empty; report new DMG size vs 188MB baseline
- [ ] `pkill -9 -f "node_modules/electron/dist"` then launch the built app; confirm: window appears instantly (splash), then thin-client attaches to `:3789` (`server-port` file absent), UI live
- [ ] Screenshot the running app windows for the README

### Task 16 (phase): README rewrite with screenshots — orchestrator

- [ ] Capture screenshots via Browser pane at desktop size (dark theme): Dashboard `/`, Monitor `/monitor` (with live agents), Analytics `/analytics` (overview + one tab), Settings `/settings`; save as `docs/screenshots/*.png` + the Electron window shot from Task 15
- [ ] Rewrite `README.md`: hero + badges + screenshots; feature tour per page; architecture (thin-client model, named-volume DB, SSE, hooks pipeline, Codex ingestion); full API reference table; setup (Docker, Electron, dev); hook installation; performance notes (before/after table from Tasks 13-14); troubleshooting (WAL/bind-mount gotcha, ABI rule, port discovery); project structure
- [ ] Update `CLAUDE.md`: Next.js 15→16 correction, `/api/live` in API list + gotchas ("probes hit /api/live, never /api/health"), new hook script layout
- [ ] Final commit + summary with before/after numbers

## Execution notes

- Tasks 2→3→4 all edit `src/lib/db.ts` — run **sequentially in that order**.
- Tasks 10→11 both touch the Electron/build layer — sequential, after Task 1.
- Tasks 5, 6, 7 are independent of each other and of 2-4 (different files) — safe to interleave between db tasks if convenient, but sequential execution is fine and simpler.
- Tasks 8 and 9 are independent of each other (monitor vs analytics files).
- Task 12 is independent of everything (hooks/ only).
- Phases 13-16 run strictly after all code tasks.
