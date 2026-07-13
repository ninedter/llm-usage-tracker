# Analytics Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Analytics page with cost breakdowns, trend charts, tool/file analytics, model insights, and auto-archival of stale agents.

**Architecture:** Hybrid layout — overview cards + trend chart at top, tabbed detail section (Sessions/Tools/Files/Models) below. New `daily_usage` table for fast historical queries. Six new API endpoints under `/api/analytics/`. Pure CSS/HTML charts, no external chart library. Auto-archive completed agents after 30 minutes.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS 4, SWR, better-sqlite3, TypeScript

---

### Task 1: Types and Constants

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/constants.ts`

- [ ] **Step 1: Add analytics types to `src/types/index.ts`**

Append after the existing `MonitorStats` interface (after line 166):

```typescript
// --- Analytics ---

export interface AnalyticsOverview {
  total_cost: number;
  cost_change_pct: number;
  session_count: number;
  avg_session_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  top_model: string;
  top_model_cost_pct: number;
  tool_call_count: number;
  tool_success_rate: number;
}

export interface TrendPoint {
  date: string;
  cost: number;
  tokens: number;
  sessions: number;
}

export interface SessionAnalyticRow {
  session_id: string;
  project: string;
  entrypoint: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
  cost: number;
  tool_count: number;
  started_at: number;
}

export interface ToolAnalyticEntry {
  tool_name: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
}

export interface ToolTimelinePoint {
  tool_name: string;
  timestamp: number;
  success: boolean;
  duration_ms: number;
}

export interface ToolAnalytics {
  tools: ToolAnalyticEntry[];
  timeline: ToolTimelinePoint[];
}

export interface FileEntry {
  file_path: string;
  directory: string;
  file_name: string;
  modification_count: number;
  tools_used: string[];
  tool_breakdown: Record<string, number>;
}

export interface FileAnalytics {
  files: FileEntry[];
  directories: { directory: string; total_modifications: number }[];
}

export interface ModelEntry {
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ModelTrendPoint {
  date: string;
  model: string;
  cost: number;
  tokens: number;
}

export interface ModelAnalytics {
  models: ModelEntry[];
  trend: ModelTrendPoint[];
}
```

- [ ] **Step 2: Update `AgentStatus` type to include `archived`**

In `src/types/index.ts`, change line 73:

```typescript
export type AgentStatus = "idle" | "working" | "completed" | "failed" | "cancelled" | "archived";
```

- [ ] **Step 3: Add archive constant to `src/lib/constants.ts`**

Append after the existing `REFRESH_INTERVALS` block (after line 28):

```typescript
export const ARCHIVE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
```

- [ ] **Step 4: Verify types compile**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/constants.ts
git commit -m "feat: add analytics types and archive constant"
```

---

### Task 2: Database Schema and Query Functions

**Files:**
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Add `daily_usage` table and indexes to the schema init block**

In `src/lib/db.ts`, inside the `db.exec(...)` block after the existing `CREATE INDEX` statements (after line 83), add:

```sql
    CREATE TABLE IF NOT EXISTS daily_usage (
      date              TEXT NOT NULL,
      model             TEXT NOT NULL,
      project           TEXT NOT NULL DEFAULT '',
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost              REAL NOT NULL DEFAULT 0,
      session_count     INTEGER NOT NULL DEFAULT 0,
      tool_calls        INTEGER NOT NULL DEFAULT 0,
      tool_failures     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, model, project)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_project ON daily_usage(project);
```

- [ ] **Step 2: Add `archiveStaleAgents()` function**

Append after the `abandonStaleSessions()` function (after line 441):

```typescript
// Archive agents that completed/failed/cancelled more than ARCHIVE_AFTER_MS ago
export function archiveStaleAgents(): number {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const d = getDb();
  const result = d.prepare(
    "UPDATE agents SET status = 'archived' WHERE status IN ('completed', 'failed', 'cancelled') AND ended_at IS NOT NULL AND ended_at < ?"
  ).run(cutoff);
  return result.changes;
}
```

- [ ] **Step 3: Add `rollupDailyUsage()` function**

Append after `archiveStaleAgents()`:

```typescript
// Aggregate today's data into daily_usage for fast trend queries
export function rollupDailyUsage(dateStr?: string): void {
  const d = getDb();
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const dayStart = new Date(date + "T00:00:00").getTime();
  const dayEnd = dayStart + 86400000;

  // Aggregate token usage by model and project for sessions that started on this date
  const tokenRows = d.prepare(`
    SELECT
      t.model,
      COALESCE(s.project, '') as project,
      SUM(t.input_tokens) as input_tokens,
      SUM(t.output_tokens) as output_tokens,
      SUM(t.cache_read_tokens) as cache_read_tokens,
      SUM(t.cache_write_tokens) as cache_write_tokens,
      SUM(t.cost) as cost,
      COUNT(DISTINCT t.session_id) as session_count
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
    GROUP BY t.model, s.project
  `).all(dayStart, dayEnd) as {
    model: string; project: string;
    input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number;
    cost: number; session_count: number;
  }[];

  // Count tool calls and failures for this date
  const toolStats = d.prepare(`
    SELECT
      COALESCE(s.project, '') as project,
      COUNT(*) as tool_calls,
      SUM(CASE WHEN ae.event_type = 'tool_result' AND ae.content LIKE '%error%' THEN 1 ELSE 0 END) as tool_failures
    FROM agent_events ae
    JOIN sessions s ON s.id = ae.session_id
    WHERE ae.event_type IN ('tool_call', 'tool_result')
      AND ae.timestamp >= ? AND ae.timestamp < ?
    GROUP BY s.project
  `).all(dayStart, dayEnd) as { project: string; tool_calls: number; tool_failures: number }[];

  const toolMap = new Map(toolStats.map(r => [r.project, r]));

  const upsert = d.prepare(`
    INSERT INTO daily_usage (date, model, project, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, session_count, tool_calls, tool_failures)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, model, project) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost = excluded.cost,
      session_count = excluded.session_count,
      tool_calls = excluded.tool_calls,
      tool_failures = excluded.tool_failures
  `);

  const runAll = d.transaction(() => {
    for (const row of tokenRows) {
      const tools = toolMap.get(row.project) || { tool_calls: 0, tool_failures: 0 };
      upsert.run(date, row.model, row.project, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.cost, row.session_count, tools.tool_calls, tools.tool_failures);
    }
  });
  runAll();
}
```

- [ ] **Step 4: Add analytics query functions**

Append after `rollupDailyUsage()`:

```typescript
// --- Analytics Queries ---

export function getAnalyticsOverview(from: number, to: number): import("@/types").AnalyticsOverview {
  const d = getDb();
  const periodLength = to - from;
  const prevFrom = from - periodLength;
  const prevTo = from;

  // Current period
  const current = d.prepare(`
    SELECT
      COALESCE(SUM(cost), 0) as total_cost,
      COUNT(DISTINCT session_id) as session_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
  `).get(from, to) as { total_cost: number; session_count: number; total_input_tokens: number; total_output_tokens: number };

  // Previous period for comparison
  const prev = d.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
  `).get(prevFrom, prevTo) as { total_cost: number };

  const costChangePct = prev.total_cost > 0
    ? ((current.total_cost - prev.total_cost) / prev.total_cost) * 100
    : 0;

  // Average session duration
  const avgDuration = d.prepare(`
    SELECT COALESCE(AVG(COALESCE(ended_at, ?) - started_at), 0) as avg_ms
    FROM sessions
    WHERE started_at >= ? AND started_at < ?
  `).get(Date.now(), from, to) as { avg_ms: number };

  // Top model by cost
  const topModel = d.prepare(`
    SELECT model, SUM(cost) as model_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
    GROUP BY model ORDER BY model_cost DESC LIMIT 1
  `).get(from, to) as { model: string; model_cost: number } | undefined;

  // Tool call stats
  const toolStats = d.prepare(`
    SELECT
      COUNT(CASE WHEN event_type = 'tool_call' THEN 1 END) as calls,
      COUNT(CASE WHEN event_type = 'tool_result' THEN 1 END) as results
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?
  `).get(from, to) as { calls: number; results: number };

  // Tool failure count (tool_call not followed by successful tool_result is approximate;
  // we count tool_result events with error-like content)
  const toolFailures = d.prepare(`
    SELECT COUNT(*) as failures
    FROM agent_events
    WHERE event_type = 'tool_result' AND timestamp >= ? AND timestamp < ?
      AND (summary LIKE '%error%' OR summary LIKE '%fail%' OR summary LIKE '%Error%')
  `).get(from, to) as { failures: number };

  const successRate = toolStats.calls > 0
    ? ((toolStats.calls - toolFailures.failures) / toolStats.calls) * 100
    : 100;

  return {
    total_cost: current.total_cost,
    cost_change_pct: Math.round(costChangePct * 10) / 10,
    session_count: current.session_count,
    avg_session_duration_ms: Math.round(avgDuration.avg_ms),
    total_input_tokens: current.total_input_tokens,
    total_output_tokens: current.total_output_tokens,
    top_model: topModel?.model || "N/A",
    top_model_cost_pct: topModel && current.total_cost > 0
      ? Math.round((topModel.model_cost / current.total_cost) * 100)
      : 0,
    tool_call_count: toolStats.calls,
    tool_success_rate: Math.round(successRate * 10) / 10,
  };
}

export function getAnalyticsTrends(from: number, to: number, granularity: "hourly" | "daily"): import("@/types").TrendPoint[] {
  const d = getDb();

  if (granularity === "daily") {
    return d.prepare(`
      SELECT
        date,
        SUM(cost) as cost,
        SUM(input_tokens + output_tokens) as tokens,
        SUM(session_count) as sessions
      FROM daily_usage
      WHERE date >= ? AND date <= ?
      GROUP BY date ORDER BY date ASC
    `).all(
      new Date(from).toISOString().slice(0, 10),
      new Date(to).toISOString().slice(0, 10)
    ) as import("@/types").TrendPoint[];
  }

  // Hourly: query events directly, group by hour
  const rows = d.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00', timestamp / 1000, 'unixepoch', 'localtime') as date,
      0 as cost,
      COUNT(*) as tokens,
      0 as sessions
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY date ORDER BY date ASC
  `).all(from, to) as import("@/types").TrendPoint[];

  return rows;
}

export function getSessionAnalytics(from: number, to: number, sort = "started_at", order = "desc", limit = 20, offset = 0): import("@/types").SessionAnalyticRow[] {
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
      (COALESCE(s.ended_at, ?) - s.started_at) as duration_ms,
      COALESCE((SELECT SUM(input_tokens + output_tokens) FROM token_usage WHERE session_id = s.id), 0) as total_tokens,
      COALESCE((SELECT SUM(cost) FROM token_usage WHERE session_id = s.id), 0) as cost,
      (SELECT COUNT(*) FROM agent_events WHERE session_id = s.id AND event_type = 'tool_call') as tool_count,
      s.started_at
    FROM sessions s
    WHERE s.started_at >= ? AND s.started_at < ?
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(Date.now(), from, to, limit, offset) as import("@/types").SessionAnalyticRow[];
}

export function getToolAnalytics(from: number, to: number): import("@/types").ToolAnalytics {
  const d = getDb();

  // Tool rankings with success/failure
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
      AND timestamp >= ? AND timestamp < ?
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all(from, to) as import("@/types").ToolAnalyticEntry[];

  // Compute success/failure by matching tool_call with subsequent tool_result
  // For each tool, count results that have error-like summaries
  for (const tool of tools) {
    const failures = d.prepare(`
      SELECT COUNT(*) as cnt FROM agent_events
      WHERE event_type = 'tool_result' AND tool_name = ?
        AND timestamp >= ? AND timestamp < ?
        AND (summary LIKE '%error%' OR summary LIKE '%fail%' OR summary LIKE '%Error%' OR summary LIKE '%FAIL%')
    `).get(tool.tool_name, from, to) as { cnt: number };
    tool.failure_count = failures.cnt;
    tool.success_count = tool.call_count - tool.failure_count;
    tool.success_rate = tool.call_count > 0
      ? Math.round((tool.success_count / tool.call_count) * 1000) / 10
      : 100;
  }

  // Compute average duration per tool (time between tool_call and next tool_result with same tool_name and agent_id)
  for (const tool of tools) {
    const avgDur = d.prepare(`
      SELECT AVG(tr.timestamp - tc.timestamp) as avg_ms
      FROM agent_events tc
      JOIN agent_events tr ON tr.agent_id = tc.agent_id
        AND tr.event_type = 'tool_result'
        AND tr.tool_name = tc.tool_name
        AND tr.timestamp > tc.timestamp
        AND tr.timestamp < tc.timestamp + 300000
      WHERE tc.event_type = 'tool_call' AND tc.tool_name = ?
        AND tc.timestamp >= ? AND tc.timestamp < ?
    `).get(tool.tool_name, from, to) as { avg_ms: number | null };
    tool.avg_duration_ms = Math.round(avgDur.avg_ms || 0);
  }

  // Timeline points (last 500 tool calls in range)
  const timeline = d.prepare(`
    SELECT
      tool_name,
      timestamp,
      1 as success,
      0 as duration_ms
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(from, to) as import("@/types").ToolTimelinePoint[];

  return { tools, timeline: timeline.reverse() };
}

export function getFileAnalytics(from: number, to: number): import("@/types").FileAnalytics {
  const d = getDb();

  // Get all events with files_affected in range
  const rows = d.prepare(`
    SELECT files_affected, tool_name
    FROM agent_events
    WHERE files_affected IS NOT NULL AND files_affected != ''
      AND timestamp >= ? AND timestamp < ?
  `).all(from, to) as { files_affected: string; tool_name: string | null }[];

  const fileMap = new Map<string, { count: number; tools: Map<string, number> }>();

  for (const row of rows) {
    let files: string[];
    try { files = JSON.parse(row.files_affected); } catch { continue; }
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (!f || typeof f !== "string") continue;
      const entry = fileMap.get(f) || { count: 0, tools: new Map() };
      entry.count++;
      if (row.tool_name) {
        entry.tools.set(row.tool_name, (entry.tools.get(row.tool_name) || 0) + 1);
      }
      fileMap.set(f, entry);
    }
  }

  const files: import("@/types").FileEntry[] = Array.from(fileMap.entries())
    .map(([filePath, data]) => {
      const parts = filePath.split("/");
      const fileName = parts.pop() || filePath;
      const directory = parts.join("/") || ".";
      return {
        file_path: filePath,
        directory,
        file_name: fileName,
        modification_count: data.count,
        tools_used: Array.from(data.tools.keys()),
        tool_breakdown: Object.fromEntries(data.tools),
      };
    })
    .sort((a, b) => b.modification_count - a.modification_count)
    .slice(0, 50);

  // Directory aggregation
  const dirMap = new Map<string, number>();
  for (const f of files) {
    dirMap.set(f.directory, (dirMap.get(f.directory) || 0) + f.modification_count);
  }
  const directories = Array.from(dirMap.entries())
    .map(([directory, total_modifications]) => ({ directory, total_modifications }))
    .sort((a, b) => b.total_modifications - a.total_modifications);

  return { files, directories };
}

export function getModelAnalytics(from: number, to: number): import("@/types").ModelAnalytics {
  const d = getDb();

  const models = d.prepare(`
    SELECT
      t.model,
      SUM(t.cost) as cost,
      SUM(t.input_tokens) as input_tokens,
      SUM(t.output_tokens) as output_tokens,
      SUM(t.cache_read_tokens) as cache_read_tokens,
      SUM(t.cache_write_tokens) as cache_write_tokens
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
    GROUP BY t.model
    ORDER BY cost DESC
  `).all(from, to) as import("@/types").ModelEntry[];

  const trend = d.prepare(`
    SELECT date, model, SUM(cost) as cost, SUM(input_tokens + output_tokens) as tokens
    FROM daily_usage
    WHERE date >= ? AND date <= ?
    GROUP BY date, model
    ORDER BY date ASC
  `).all(
    new Date(from).toISOString().slice(0, 10),
    new Date(to).toISOString().slice(0, 10)
  ) as import("@/types").ModelTrendPoint[];

  return { models, trend };
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat: add daily_usage table, analytics queries, archive and rollup functions"
```

---

### Task 3: Auto-Archive Integration

**Files:**
- Modify: `src/app/api/monitor/stats/route.ts`
- Modify: `src/hooks/use-agent-monitor.ts`

- [ ] **Step 1: Call `archiveStaleAgents()` from stats endpoint**

In `src/app/api/monitor/stats/route.ts`, update the import on line 2:

```typescript
import { getMonitorStats, abandonStaleSessions, archiveStaleAgents } from "@/lib/db";
```

Add the call after `abandonStaleSessions()` (after the line that currently calls it):

```typescript
    abandonStaleSessions();
    archiveStaleAgents();
    const stats = getMonitorStats();
```

- [ ] **Step 2: Filter archived agents from monitor**

In `src/hooks/use-agent-monitor.ts`, update the `agentList` useMemo to filter out archived agents. Change the existing useMemo:

```typescript
  const agentList = useMemo(() =>
    Array.from(agents.values())
      .filter((a) => a.status !== "archived")
      .sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? 3;
        const pb = STATUS_PRIORITY[b.status] ?? 3;
        if (pa !== pb) return pa - pb;
        return b.started_at - a.started_at;
      }),
    [agents]
  );
```

- [ ] **Step 3: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/monitor/stats/route.ts src/hooks/use-agent-monitor.ts
git commit -m "feat: auto-archive stale agents, filter from monitor view"
```

---

### Task 4: Analytics API Routes

**Files:**
- Create: `src/app/api/analytics/overview/route.ts`
- Create: `src/app/api/analytics/trends/route.ts`
- Create: `src/app/api/analytics/sessions/route.ts`
- Create: `src/app/api/analytics/tools/route.ts`
- Create: `src/app/api/analytics/files/route.ts`
- Create: `src/app/api/analytics/models/route.ts`

- [ ] **Step 1: Create overview route**

Create `src/app/api/analytics/overview/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsOverview, rollupDailyUsage } from "@/lib/db";
import type { ApiResponse, AnalyticsOverview } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<AnalyticsOverview>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    // Ensure today's rollup is fresh
    rollupDailyUsage();

    const data = getAnalyticsOverview(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get overview" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create trends route**

Create `src/app/api/analytics/trends/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsTrends, rollupDailyUsage } from "@/lib/db";
import type { ApiResponse, TrendPoint } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<TrendPoint[]>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));
    const range = to - from;
    const granularity = range <= 2 * 86400000 ? "hourly" : "daily";

    rollupDailyUsage();

    const data = getAnalyticsTrends(from, to, granularity);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get trends" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Create sessions route**

Create `src/app/api/analytics/sessions/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionAnalytics } from "@/lib/db";
import type { ApiResponse, SessionAnalyticRow } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<SessionAnalyticRow[]>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));
    const sort = url.searchParams.get("sort") || "started_at";
    const order = url.searchParams.get("order") || "desc";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const data = getSessionAnalytics(from, to, sort, order, limit, offset);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get sessions" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4: Create tools route**

Create `src/app/api/analytics/tools/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getToolAnalytics } from "@/lib/db";
import type { ApiResponse, ToolAnalytics } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<ToolAnalytics>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    const data = getToolAnalytics(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get tool analytics" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 5: Create files route**

Create `src/app/api/analytics/files/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getFileAnalytics } from "@/lib/db";
import type { ApiResponse, FileAnalytics } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<FileAnalytics>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    const data = getFileAnalytics(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get file analytics" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 6: Create models route**

Create `src/app/api/analytics/models/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getModelAnalytics, rollupDailyUsage } from "@/lib/db";
import type { ApiResponse, ModelAnalytics } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<ModelAnalytics>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    rollupDailyUsage();

    const data = getModelAnalytics(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get model analytics" } },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 7: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/app/api/analytics/
git commit -m "feat: add 6 analytics API routes (overview, trends, sessions, tools, files, models)"
```

---

### Task 5: Analytics Hook

**Files:**
- Create: `src/hooks/use-analytics.ts`

- [ ] **Step 1: Create the analytics hook**

Create `src/hooks/use-analytics.ts`:

```typescript
"use client";

import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import type {
  ApiResponse,
  AnalyticsOverview,
  TrendPoint,
  SessionAnalyticRow,
  ToolAnalytics,
  FileAnalytics,
  ModelAnalytics,
} from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

type Preset = "today" | "7d" | "30d" | "all";

function presetToRange(preset: Preset): { from: number; to: number } {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { from: today.getTime(), to: now };
    case "7d":
      return { from: now - 7 * 86400000, to: now };
    case "30d":
      return { from: now - 30 * 86400000, to: now };
    case "all":
      return { from: 0, to: now };
  }
}

export function useAnalytics() {
  const [preset, setPresetState] = useState<Preset>("7d");
  const [customRange, setCustomRangeState] = useState<{ from: number; to: number } | null>(null);

  const timeRange = useMemo(() => {
    if (customRange) return customRange;
    return presetToRange(preset);
  }, [preset, customRange]);

  const setPreset = useCallback((p: Preset) => {
    setPresetState(p);
    setCustomRangeState(null);
  }, []);

  const setCustomRange = useCallback((from: number, to: number) => {
    setCustomRangeState({ from, to });
  }, []);

  const params = `from=${timeRange.from}&to=${timeRange.to}`;
  const swrOpts = { revalidateOnFocus: false, refreshInterval: 60_000 };

  const { data: overview, isLoading: overviewLoading } = useSWR<AnalyticsOverview>(
    `/api/analytics/overview?${params}`, fetcher, swrOpts
  );

  const { data: trends, isLoading: trendsLoading } = useSWR<TrendPoint[]>(
    `/api/analytics/trends?${params}`, fetcher, swrOpts
  );

  const [sessionSort, setSessionSort] = useState<{ sort: string; order: string }>({ sort: "started_at", order: "desc" });
  const [sessionPage, setSessionPage] = useState(0);

  const { data: sessions, isLoading: sessionsLoading } = useSWR<SessionAnalyticRow[]>(
    `/api/analytics/sessions?${params}&sort=${sessionSort.sort}&order=${sessionSort.order}&limit=20&offset=${sessionPage * 20}`,
    fetcher, swrOpts
  );

  const { data: toolAnalytics, isLoading: toolsLoading } = useSWR<ToolAnalytics>(
    `/api/analytics/tools?${params}`, fetcher, swrOpts
  );

  const { data: fileAnalytics, isLoading: filesLoading } = useSWR<FileAnalytics>(
    `/api/analytics/files?${params}`, fetcher, swrOpts
  );

  const { data: modelAnalytics, isLoading: modelsLoading } = useSWR<ModelAnalytics>(
    `/api/analytics/models?${params}`, fetcher, swrOpts
  );

  return {
    // Time range
    preset,
    timeRange,
    setPreset,
    setCustomRange,
    // Data
    overview: overview || null,
    trends: trends || [],
    sessions: sessions || [],
    toolAnalytics: toolAnalytics || null,
    fileAnalytics: fileAnalytics || null,
    modelAnalytics: modelAnalytics || null,
    // Loading states
    overviewLoading,
    trendsLoading,
    sessionsLoading,
    toolsLoading,
    filesLoading,
    modelsLoading,
    // Session table controls
    sessionSort,
    setSessionSort,
    sessionPage,
    setSessionPage,
  };
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-analytics.ts
git commit -m "feat: add useAnalytics hook with time range management and SWR fetches"
```

---

### Task 6: TimeRangePicker and OverviewCards Components

**Files:**
- Create: `src/components/analytics/TimeRangePicker.tsx`
- Create: `src/components/analytics/OverviewCards.tsx`

- [ ] **Step 1: Create TimeRangePicker**

Create `src/components/analytics/TimeRangePicker.tsx`:

```typescript
"use client";

import { useState } from "react";

type Preset = "today" | "7d" | "30d" | "all";

interface TimeRangePickerProps {
  preset: Preset;
  onPresetChange: (preset: Preset) => void;
  onCustomRange: (from: number, to: number) => void;
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function TimeRangePicker({ preset, onPresetChange, onCustomRange }: TimeRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const handleApplyCustom = () => {
    if (fromDate && toDate) {
      onCustomRange(
        new Date(fromDate).getTime(),
        new Date(toDate + "T23:59:59").getTime()
      );
      setShowCustom(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-lg border border-zinc-700 bg-zinc-800 p-0.5">
        {PRESETS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onPresetChange(value)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              preset === value && !showCustom
                ? "bg-zinc-600 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="relative">
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium transition-colors ${
            showCustom ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Custom...
        </button>
        {showCustom && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowCustom(false)} />
            <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 p-3 shadow-xl">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                />
                <span className="text-xs text-zinc-500">to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                />
                <button
                  onClick={handleApplyCustom}
                  className="rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500"
                >
                  Apply
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create OverviewCards**

Create `src/components/analytics/OverviewCards.tsx`:

```typescript
"use client";

import type { AnalyticsOverview } from "@/types";

interface OverviewCardsProps {
  data: AnalyticsOverview | null;
  loading: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

export function OverviewCards({ data, loading }: OverviewCardsProps) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="h-3 w-16 rounded bg-zinc-800" />
            <div className="mt-2 h-6 w-20 rounded bg-zinc-800" />
          </div>
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "Total Cost",
      value: `$${data.total_cost.toFixed(2)}`,
      sub: data.cost_change_pct !== 0
        ? `${data.cost_change_pct > 0 ? "+" : ""}${data.cost_change_pct.toFixed(1)}% vs prev`
        : null,
      subColor: data.cost_change_pct > 0 ? "text-red-400" : "text-emerald-400",
    },
    {
      label: "Sessions",
      value: String(data.session_count),
      sub: `avg ${formatDuration(data.avg_session_duration_ms)} per session`,
      subColor: "text-zinc-500",
    },
    {
      label: "Tokens Used",
      value: formatTokens(data.total_input_tokens + data.total_output_tokens),
      sub: `${formatTokens(data.total_input_tokens)} in / ${formatTokens(data.total_output_tokens)} out`,
      subColor: "text-zinc-500",
    },
    {
      label: "Top Model",
      value: data.top_model.replace("claude-", "").replace("-latest", ""),
      sub: `${data.top_model_cost_pct}% of cost`,
      subColor: "text-zinc-500",
      valueColor: "text-violet-400",
    },
    {
      label: "Tool Calls",
      value: String(data.tool_call_count),
      sub: `${data.tool_success_rate}% success`,
      subColor: data.tool_success_rate >= 95 ? "text-emerald-400" : data.tool_success_rate >= 80 ? "text-amber-400" : "text-red-400",
    },
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">{card.label}</p>
          <p className={`mt-1 text-xl font-bold ${card.valueColor || "text-zinc-100"}`}>{card.value}</p>
          {card.sub && <p className={`mt-0.5 text-[10px] ${card.subColor}`}>{card.sub}</p>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/analytics/TimeRangePicker.tsx src/components/analytics/OverviewCards.tsx
git commit -m "feat: add TimeRangePicker and OverviewCards components"
```

---

### Task 7: TrendChart Component

**Files:**
- Create: `src/components/analytics/TrendChart.tsx`

- [ ] **Step 1: Create TrendChart**

Create `src/components/analytics/TrendChart.tsx`:

```typescript
"use client";

import type { TrendPoint } from "@/types";

interface TrendChartProps {
  data: TrendPoint[];
  loading: boolean;
}

export function TrendChart({ data, loading }: TrendChartProps) {
  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="h-4 w-32 rounded bg-zinc-800" />
        <div className="mt-4 flex items-end gap-2 h-24">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex-1 rounded-t bg-zinc-800" style={{ height: `${30 + Math.random() * 60}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs text-zinc-600 text-center py-8">No trend data for this period</p>
      </div>
    );
  }

  const maxCost = Math.max(...data.map((d) => d.cost), 0.01);
  const maxTokens = Math.max(...data.map((d) => d.tokens), 1);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-200">Cost & Token Trend</p>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            <span className="text-zinc-400">Cost</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
            <span className="text-zinc-400">Tokens</span>
          </span>
        </div>
      </div>

      <div className="flex items-end gap-1.5" style={{ height: 100 }}>
        {data.map((point, i) => {
          const costH = maxCost > 0 ? (point.cost / maxCost) * 100 : 0;
          const tokenH = maxTokens > 0 ? (point.tokens / maxTokens) * 100 : 0;
          const label = formatDateLabel(point.date);
          const isToday = point.date === new Date().toISOString().slice(0, 10);

          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
              {/* Tooltip */}
              <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
                <div className="rounded-md bg-zinc-700 px-2 py-1 text-[9px] text-zinc-200 whitespace-nowrap shadow-lg">
                  <p className="font-medium">{point.date}</p>
                  <p className="text-emerald-300">${point.cost.toFixed(2)}</p>
                  <p className="text-blue-300">{point.tokens.toLocaleString()} tokens</p>
                  <p className="text-zinc-400">{point.sessions} sessions</p>
                </div>
              </div>
              <div className="w-full flex gap-0.5 items-end justify-center" style={{ height: 80 }}>
                <div
                  className="w-2/5 rounded-t bg-emerald-500 transition-all"
                  style={{ height: `${Math.max(costH, 2)}%` }}
                />
                <div
                  className="w-2/5 rounded-t bg-blue-500/60 transition-all"
                  style={{ height: `${Math.max(tokenH, 2)}%` }}
                />
              </div>
              <span className={`text-[8px] ${isToday ? "text-violet-400 font-medium" : "text-zinc-600"}`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDateLabel(date: string): string {
  if (date.includes("T")) {
    // Hourly format: show just the hour
    return date.split("T")[1]?.slice(0, 5) || date;
  }
  // Daily format: show day of week or short date
  const d = new Date(date + "T12:00:00");
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/TrendChart.tsx
git commit -m "feat: add TrendChart component with CSS bar chart and hover tooltips"
```

---

### Task 8: SessionsTable Component

**Files:**
- Create: `src/components/analytics/SessionsTable.tsx`

- [ ] **Step 1: Create SessionsTable**

Create `src/components/analytics/SessionsTable.tsx`:

```typescript
"use client";

import type { SessionAnalyticRow } from "@/types";

interface SessionsTableProps {
  data: SessionAnalyticRow[];
  loading: boolean;
  sort: { sort: string; order: string };
  onSort: (sort: { sort: string; order: string }) => void;
  page: number;
  onPageChange: (page: number) => void;
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const STATUS_STYLES: Record<string, string> = {
  active: "text-emerald-400 bg-emerald-500/10",
  completed: "text-zinc-400 bg-zinc-500/10",
  error: "text-red-400 bg-red-500/10",
  abandoned: "text-amber-400 bg-amber-500/10",
};

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: "project", label: "Project", sortable: false },
  { key: "duration", label: "Duration", sortable: true },
  { key: "tokens", label: "Tokens", sortable: true },
  { key: "cost", label: "Cost", sortable: true },
  { key: "tools", label: "Tools", sortable: false },
  { key: "status", label: "Status", sortable: false },
];

export function SessionsTable({ data, loading, sort, onSort, page, onPageChange }: SessionsTableProps) {
  const handleSort = (key: string) => {
    if (sort.sort === key) {
      onSort({ sort: key, order: sort.order === "asc" ? "desc" : "asc" });
    } else {
      onSort({ sort: key, order: "desc" });
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-2 px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            onClick={() => col.sortable && handleSort(col.key)}
            className={`text-left ${col.sortable ? "cursor-pointer hover:text-zinc-300" : "cursor-default"}`}
          >
            {col.label}
            {col.sortable && sort.sort === col.key && (
              <span className="ml-1">{sort.order === "asc" ? "\u2191" : "\u2193"}</span>
            )}
          </button>
        ))}
      </div>

      {/* Rows */}
      {data.length === 0 ? (
        <p className="text-center text-xs text-zinc-600 py-8">No sessions in this period</p>
      ) : (
        data.map((session) => {
          const entryLabel = session.entrypoint === "claude-desktop" ? "Desktop"
            : session.entrypoint === "cli" ? "Terminal"
            : session.entrypoint || "Agent";

          return (
            <div
              key={session.session_id}
              className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-2 px-3 py-2 text-[11px] border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors items-center"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-zinc-200 font-medium truncate">{session.project || session.session_id.slice(0, 8)}</span>
                <span className="flex-shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-500">{entryLabel}</span>
              </div>
              <div className="text-zinc-400 font-mono text-[10px]">{formatDuration(session.duration_ms)}</div>
              <div className="text-zinc-400 font-mono text-[10px]">{formatTokens(session.total_tokens)}</div>
              <div className="text-emerald-400 font-mono text-[10px] font-semibold">${session.cost.toFixed(2)}</div>
              <div className="text-zinc-400 font-mono text-[10px]">{session.tool_count}</div>
              <div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-medium ${STATUS_STYLES[session.status] || STATUS_STYLES.completed}`}>
                  {session.status}
                </span>
              </div>
            </div>
          );
        })
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span className="text-[10px] text-zinc-600">Page {page + 1}</span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={data.length < 20}
          className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/SessionsTable.tsx
git commit -m "feat: add SessionsTable with sortable columns and pagination"
```

---

### Task 9: ToolsPanel Component

**Files:**
- Create: `src/components/analytics/ToolsPanel.tsx`

- [ ] **Step 1: Create ToolsPanel**

Create `src/components/analytics/ToolsPanel.tsx`:

```typescript
"use client";

import type { ToolAnalytics } from "@/types";

interface ToolsPanelProps {
  data: ToolAnalytics | null;
  loading: boolean;
}

const TOOL_COLORS: Record<string, string> = {
  Read: "bg-blue-500",
  Edit: "bg-violet-500",
  Bash: "bg-emerald-500",
  Grep: "bg-amber-500",
  Write: "bg-pink-500",
  Glob: "bg-cyan-500",
  Agent: "bg-orange-500",
};

function getToolColor(name: string): string {
  return TOOL_COLORS[name] || "bg-zinc-500";
}

export function ToolsPanel({ data, loading }: ToolsPanelProps) {
  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-6 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { tools, timeline } = data;
  const maxCount = Math.max(...tools.map((t) => t.call_count), 1);

  // Group timeline by tool for swim lane
  const toolNames = tools.map((t) => t.tool_name);
  const timelineByTool = new Map<string, typeof timeline>();
  for (const name of toolNames) {
    timelineByTool.set(name, timeline.filter((p) => p.tool_name === name));
  }
  const minTs = timeline.length > 0 ? Math.min(...timeline.map((p) => p.timestamp)) : 0;
  const maxTs = timeline.length > 0 ? Math.max(...timeline.map((p) => p.timestamp)) : 1;
  const tsRange = maxTs - minTs || 1;

  return (
    <div className="p-3 space-y-4">
      {/* Top row: Rankings + Success Rates */}
      <div className="grid grid-cols-2 gap-3">
        {/* Most Used */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Most Used Tools</p>
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div key={tool.tool_name} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 font-mono w-14 text-right">{tool.tool_name}</span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${getToolColor(tool.tool_name)}`}
                    style={{ width: `${(tool.call_count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-600 font-mono w-8 text-right">{tool.call_count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Success / Failure Rate */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Success / Failure Rate</p>
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div key={tool.tool_name} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 font-mono w-14 text-right">{tool.tool_name}</span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${tool.success_rate}%` }} />
                  <div className="h-full bg-red-500" style={{ width: `${100 - tool.success_rate}%` }} />
                </div>
                <span className={`text-[10px] font-mono w-10 text-right ${tool.success_rate >= 95 ? "text-emerald-400" : tool.success_rate >= 80 ? "text-amber-400" : "text-red-400"}`}>
                  {tool.success_rate}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tool Call Timeline */}
      {timeline.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Tool Call Timeline</p>
            <p className="text-[8px] text-zinc-600">
              {new Date(minTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
              {" — "}
              {new Date(maxTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <div className="space-y-1">
            {toolNames.slice(0, 8).map((name) => {
              const points = timelineByTool.get(name) || [];
              return (
                <div key={name} className="flex items-center gap-2 h-4">
                  <span className="text-[8px] text-zinc-500 font-mono w-12 text-right">{name}</span>
                  <div className="flex-1 h-3.5 bg-zinc-900 rounded relative overflow-hidden">
                    {points.map((p, i) => {
                      const left = ((p.timestamp - minTs) / tsRange) * 100;
                      return (
                        <div
                          key={i}
                          className={`absolute top-0 h-full rounded-sm ${p.success ? getToolColor(name) : "bg-red-500"}`}
                          style={{
                            left: `${left}%`,
                            width: Math.max(2, (p.duration_ms / tsRange) * 100) + "px",
                            opacity: 0.8,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-3 mt-2 text-[8px] text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-sm bg-emerald-500" /> Success
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-sm bg-red-500" /> Failed
            </span>
          </div>
        </div>
      )}

      {/* Average Duration */}
      {tools.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Average Duration per Tool</p>
          <div className="grid grid-cols-4 gap-2">
            {tools
              .filter((t) => t.avg_duration_ms > 0)
              .sort((a, b) => b.avg_duration_ms - a.avg_duration_ms)
              .slice(0, 8)
              .map((tool) => (
                <div key={tool.tool_name} className="text-center rounded-lg bg-zinc-900 p-2">
                  <p className="text-[9px] text-zinc-500">{tool.tool_name}</p>
                  <p className={`text-sm font-bold mt-0.5 ${tool.avg_duration_ms > 5000 ? "text-amber-400" : "text-zinc-300"}`}>
                    {tool.avg_duration_ms >= 1000
                      ? `${(tool.avg_duration_ms / 1000).toFixed(1)}s`
                      : `${tool.avg_duration_ms}ms`}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/ToolsPanel.tsx
git commit -m "feat: add ToolsPanel with rankings, success rates, timeline, and duration cards"
```

---

### Task 10: FilesPanel Component

**Files:**
- Create: `src/components/analytics/FilesPanel.tsx`

- [ ] **Step 1: Create FilesPanel**

Create `src/components/analytics/FilesPanel.tsx`:

```typescript
"use client";

import { useState } from "react";
import type { FileAnalytics, FileEntry } from "@/types";

interface FilesPanelProps {
  data: FileAnalytics | null;
  loading: boolean;
}

const TOOL_BADGE_COLORS: Record<string, string> = {
  Read: "text-blue-400 bg-blue-500/10",
  Edit: "text-violet-400 bg-violet-500/10",
  Write: "text-pink-400 bg-pink-500/10",
  Grep: "text-amber-400 bg-amber-500/10",
  Bash: "text-emerald-400 bg-emerald-500/10",
  Glob: "text-cyan-400 bg-cyan-500/10",
};

const TOOL_BAR_COLORS: Record<string, string> = {
  Read: "bg-blue-500",
  Edit: "bg-violet-500",
  Write: "bg-pink-500",
  Grep: "bg-amber-500",
  Bash: "bg-emerald-500",
  Glob: "bg-cyan-500",
};

function getHeatmapColor(count: number, max: number): string {
  const ratio = count / max;
  if (ratio > 0.75) return "bg-violet-600";
  if (ratio > 0.5) return "bg-violet-700";
  if (ratio > 0.25) return "bg-violet-800";
  return "bg-violet-900/60";
}

export function FilesPanel({ data, loading }: FilesPanelProps) {
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { files, directories } = data;
  const maxMod = Math.max(...files.map((f) => f.modification_count), 1);
  const activeFile = selectedFile || files[0] || null;

  return (
    <div className="p-3 space-y-4">
      {/* Modification Heatmap */}
      {directories.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Modification Heatmap</p>
          <div className="space-y-2">
            {directories.slice(0, 10).map((dir) => {
              const dirFiles = files.filter((f) => f.directory === dir.directory);
              return (
                <div key={dir.directory}>
                  <p className="text-[8px] text-zinc-600 mb-1">{dir.directory}/</p>
                  <div className="flex gap-1 pl-2 flex-wrap">
                    {dirFiles.map((f) => (
                      <div
                        key={f.file_path}
                        className={`w-3.5 h-3.5 rounded cursor-pointer transition-all hover:ring-1 hover:ring-violet-400 ${getHeatmapColor(f.modification_count, maxMod)}`}
                        title={`${f.file_name} — ${f.modification_count} edits`}
                        onClick={() => setSelectedFile(f)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-1 mt-3 text-[7px] text-zinc-600">
            <span>Less</span>
            <div className="w-2.5 h-2.5 rounded bg-violet-900/60" />
            <div className="w-2.5 h-2.5 rounded bg-violet-800" />
            <div className="w-2.5 h-2.5 rounded bg-violet-700" />
            <div className="w-2.5 h-2.5 rounded bg-violet-600" />
            <span>More</span>
          </div>
        </div>
      )}

      {/* Most Modified Files */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Most Modified Files</p>
        <div className="space-y-1">
          {files.slice(0, 10).map((f, i) => (
            <button
              key={f.file_path}
              onClick={() => setSelectedFile(f)}
              className={`flex items-center gap-2 w-full rounded px-2 py-1.5 text-left transition-colors ${
                activeFile?.file_path === f.file_path ? "bg-zinc-800" : "hover:bg-zinc-800/50"
              }`}
            >
              <span className="text-[9px] text-violet-400 font-semibold w-4">{i + 1}</span>
              <span className="text-[9px] text-zinc-200 font-mono flex-1 truncate">{f.file_name}</span>
              <span className="text-[8px] text-zinc-600 font-mono">{f.modification_count}</span>
              <div className="flex gap-1">
                {f.tools_used.slice(0, 3).map((tool) => (
                  <span key={tool} className={`text-[7px] rounded px-1 py-0.5 ${TOOL_BADGE_COLORS[tool] || "text-zinc-400 bg-zinc-500/10"}`}>
                    {tool}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Per-File Tool Breakdown */}
      {activeFile && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Tool Breakdown</p>
          <p className="text-[8px] text-zinc-400 font-mono mb-2">{activeFile.file_name}</p>
          <div className="h-2.5 flex rounded-full overflow-hidden gap-px">
            {Object.entries(activeFile.tool_breakdown).map(([tool, count]) => {
              const pct = (count / activeFile.modification_count) * 100;
              return (
                <div
                  key={tool}
                  className={`${TOOL_BAR_COLORS[tool] || "bg-zinc-500"}`}
                  style={{ width: `${pct}%` }}
                  title={`${tool}: ${count} (${Math.round(pct)}%)`}
                />
              );
            })}
          </div>
          <div className="flex gap-2 mt-2 text-[7px] text-zinc-600 flex-wrap">
            {Object.entries(activeFile.tool_breakdown).map(([tool, count]) => (
              <span key={tool}>
                <span className={`inline-block w-1.5 h-1.5 rounded-sm mr-0.5 ${TOOL_BAR_COLORS[tool] || "bg-zinc-500"}`} />
                {tool} {Math.round((count / activeFile.modification_count) * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {files.length === 0 && (
        <p className="text-center text-xs text-zinc-600 py-8">No file modifications recorded in this period</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/FilesPanel.tsx
git commit -m "feat: add FilesPanel with heatmap, ranked list, and tool breakdown"
```

---

### Task 11: ModelsPanel Component

**Files:**
- Create: `src/components/analytics/ModelsPanel.tsx`

- [ ] **Step 1: Create ModelsPanel**

Create `src/components/analytics/ModelsPanel.tsx`:

```typescript
"use client";

import type { ModelAnalytics } from "@/types";

interface ModelsPanelProps {
  data: ModelAnalytics | null;
  loading: boolean;
}

const MODEL_COLORS = ["#a78bfa", "#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#22d3ee"];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function shortModelName(model: string): string {
  return model.replace("claude-", "").replace("-latest", "").replace("-20250", "");
}

export function ModelsPanel({ data, loading }: ModelsPanelProps) {
  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { models, trend } = data;
  const totalCost = models.reduce((s, m) => s + m.cost, 0);

  // Build donut segments
  let offset = 25; // start at top
  const segments = models.map((m, i) => {
    const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
    const seg = { ...m, pct, color: MODEL_COLORS[i % MODEL_COLORS.length], offset };
    offset -= pct;
    return seg;
  });

  // Group trend by date for stacked chart
  const trendDates = [...new Set(trend.map((t) => t.date))].sort();
  const trendModels = [...new Set(trend.map((t) => t.model))];
  const maxDayCost = Math.max(
    ...trendDates.map((d) =>
      trend.filter((t) => t.date === d).reduce((s, t) => s + t.cost, 0)
    ),
    0.01
  );

  return (
    <div className="p-3 space-y-4">
      {/* Cost Donut */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Cost by Model</p>
        <div className="flex items-center gap-6">
          <svg width="120" height="120" viewBox="0 0 42 42" className="flex-shrink-0">
            {segments.map((seg, i) => (
              <circle
                key={i}
                cx="21" cy="21" r="15.9"
                fill="none"
                stroke={seg.color}
                strokeWidth="5"
                strokeDasharray={`${seg.pct} ${100 - seg.pct}`}
                strokeDashoffset={seg.offset}
              />
            ))}
            <text x="21" y="20" textAnchor="middle" fontSize="5" fill="#f4f4f5" fontWeight="700">
              ${totalCost.toFixed(2)}
            </text>
            <text x="21" y="25" textAnchor="middle" fontSize="3" fill="#71717a">
              total
            </text>
          </svg>
          <div className="space-y-2 flex-1">
            {segments.map((seg) => (
              <div key={seg.model} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-sm" style={{ background: seg.color }} />
                  <span className="text-[10px] text-zinc-200">{shortModelName(seg.model)}</span>
                </div>
                <span className="text-[10px] font-mono font-semibold" style={{ color: seg.color }}>
                  ${seg.cost.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Token Breakdown */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Token Breakdown</p>
        <div className="space-y-3">
          {models.map((m, i) => {
            const total = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens;
            if (total === 0) return null;
            const parts = [
              { label: "Input", tokens: m.input_tokens, opacity: "1" },
              { label: "Output", tokens: m.output_tokens, opacity: "0.8" },
              { label: "Cache Read", tokens: m.cache_read_tokens, opacity: "0.4" },
              { label: "Cache Write", tokens: m.cache_write_tokens, opacity: "0.25" },
            ];
            return (
              <div key={m.model}>
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] text-zinc-200">{shortModelName(m.model)}</span>
                  <span className="text-[8px] text-zinc-500 font-mono">{formatTokens(total)} total</span>
                </div>
                <div className="h-2 flex rounded-full overflow-hidden gap-px">
                  {parts.map((part) => {
                    const pct = (part.tokens / total) * 100;
                    if (pct < 0.5) return null;
                    return (
                      <div
                        key={part.label}
                        style={{
                          width: `${pct}%`,
                          background: MODEL_COLORS[i % MODEL_COLORS.length],
                          opacity: part.opacity,
                        }}
                        title={`${part.label}: ${formatTokens(part.tokens)}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-3 mt-2 text-[7px] text-zinc-600">
          <span>Input</span>
          <span style={{ opacity: 0.8 }}>Output</span>
          <span style={{ opacity: 0.5 }}>Cache Read</span>
          <span style={{ opacity: 0.3 }}>Cache Write</span>
        </div>
      </div>

      {/* Model Usage Over Time */}
      {trendDates.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Usage Over Time</p>
          <div className="flex items-end gap-1" style={{ height: 80 }}>
            {trendDates.map((date) => {
              const dayData = trend.filter((t) => t.date === date);
              const isToday = date === new Date().toISOString().slice(0, 10);
              return (
                <div key={date} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full flex flex-col-reverse" style={{ height: 65 }}>
                    {trendModels.map((model, mi) => {
                      const entry = dayData.find((d) => d.model === model);
                      if (!entry || entry.cost === 0) return null;
                      const h = (entry.cost / maxDayCost) * 100;
                      return (
                        <div
                          key={model}
                          className="w-full rounded-sm"
                          style={{
                            height: `${h}%`,
                            background: MODEL_COLORS[mi % MODEL_COLORS.length],
                            minHeight: 2,
                          }}
                        />
                      );
                    })}
                  </div>
                  <span className={`text-[7px] ${isToday ? "text-violet-400" : "text-zinc-700"}`}>
                    {new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "narrow" })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {models.length === 0 && (
        <p className="text-center text-xs text-zinc-600 py-8">No model usage data in this period</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/ModelsPanel.tsx
git commit -m "feat: add ModelsPanel with donut chart, token breakdown, and usage timeline"
```

---

### Task 12: Analytics Page and Navigation

**Files:**
- Create: `src/app/analytics/page.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Create the analytics page**

Create `src/app/analytics/page.tsx`:

```typescript
"use client";

import Link from "next/link";
import { useState } from "react";
import { useAnalytics } from "@/hooks/use-analytics";
import { TimeRangePicker } from "@/components/analytics/TimeRangePicker";
import { OverviewCards } from "@/components/analytics/OverviewCards";
import { TrendChart } from "@/components/analytics/TrendChart";
import { SessionsTable } from "@/components/analytics/SessionsTable";
import { ToolsPanel } from "@/components/analytics/ToolsPanel";
import { FilesPanel } from "@/components/analytics/FilesPanel";
import { ModelsPanel } from "@/components/analytics/ModelsPanel";

type DetailTab = "sessions" | "tools" | "files" | "models";

export default function AnalyticsPage() {
  const {
    preset, setPreset, setCustomRange,
    overview, trends, sessions,
    toolAnalytics, fileAnalytics, modelAnalytics,
    overviewLoading, trendsLoading, sessionsLoading,
    toolsLoading, filesLoading, modelsLoading,
    sessionSort, setSessionSort,
    sessionPage, setSessionPage,
  } = useAnalytics();

  const [activeTab, setActiveTab] = useState<DetailTab>("sessions");

  return (
    <div className="mx-auto flex w-full flex-1 flex-col px-4 pb-4">
      {/* Header */}
      <div className="titlebar-drag mb-4 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Analytics</h1>
          <p className="mt-0.5 text-xs text-zinc-500">Usage insights and cost breakdown</p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <TimeRangePicker
            preset={preset}
            onPresetChange={setPreset}
            onCustomRange={setCustomRange}
          />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Dashboard
          </Link>
        </div>
      </div>

      {/* Overview Section */}
      <div className="space-y-3 mb-4">
        <OverviewCards data={overview} loading={overviewLoading} />
        <TrendChart data={trends} loading={trendsLoading} />
      </div>

      {/* Detail Section */}
      <div className="flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        {/* Tabs */}
        <div className="flex border-b border-zinc-800 px-1">
          {(["sessions", "tools", "files", "models"] as DetailTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-xs font-semibold transition-colors ${
                activeTab === tab
                  ? "text-zinc-100 border-b-2 border-violet-500 -mb-px"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 380px)" }}>
          {activeTab === "sessions" && (
            <SessionsTable
              data={sessions}
              loading={sessionsLoading}
              sort={sessionSort}
              onSort={setSessionSort}
              page={sessionPage}
              onPageChange={setSessionPage}
            />
          )}
          {activeTab === "tools" && (
            <ToolsPanel data={toolAnalytics} loading={toolsLoading} />
          )}
          {activeTab === "files" && (
            <FilesPanel data={fileAnalytics} loading={filesLoading} />
          )}
          {activeTab === "models" && (
            <ModelsPanel data={modelAnalytics} loading={modelsLoading} />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add Analytics link to dashboard header**

In `src/app/page.tsx`, add the Analytics link after the RefreshControl and before the Settings link. Replace the nav section (lines 21-48) — specifically add a new `<Link>` between `<RefreshControl />` and the Settings link:

After the `<RefreshControl />` line and before the Settings `<Link>`, add:

```typescript
          <Link
            href="/analytics"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            Analytics
          </Link>
```

- [ ] **Step 3: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Build and verify**

Run: `cd llm-usage-tracker && npm run build`
Expected: Build succeeds with new `/analytics` route listed

- [ ] **Step 5: Commit**

```bash
git add src/app/analytics/page.tsx src/app/page.tsx
git commit -m "feat: add Analytics page with full dashboard and navigation link"
```

---

### Task 13: Debounced Rollup from Events Endpoint

**Files:**
- Modify: `src/app/api/monitor/events/route.ts`

- [ ] **Step 1: Add debounced rollup trigger**

In `src/app/api/monitor/events/route.ts`, add the import at the top (after the existing imports):

```typescript
import { rollupDailyUsage } from "@/lib/db";
```

Add a module-level debounce variable before the `POST` function:

```typescript
let lastRollup = 0;
```

At the end of the POST handler, just before the final `return NextResponse.json(...)` line (before line 151), add:

```typescript
    // Trigger daily rollup at most once per 60 seconds
    const now = Date.now();
    if (now - lastRollup > 60_000) {
      lastRollup = now;
      try { rollupDailyUsage(); } catch { /* ignore rollup errors */ }
    }
```

- [ ] **Step 2: Verify compilation**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/monitor/events/route.ts
git commit -m "feat: trigger debounced daily_usage rollup from events endpoint"
```

---

### Task 14: Final Build and Verification

**Files:** None (verification only)

- [ ] **Step 1: Full type check**

Run: `cd llm-usage-tracker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full build**

Run: `cd llm-usage-tracker && npm run build`
Expected: Build succeeds, `/analytics` route listed in output

- [ ] **Step 3: Compile Electron**

Run: `cd llm-usage-tracker && npm run electron:compile`
Expected: No errors

- [ ] **Step 4: Copy standalone assets**

```bash
cd llm-usage-tracker
STANDALONE=".next/standalone"
NESTED="$STANDALONE/LLMUsage/llm-usage-tracker"
cp "$NESTED/server.js" "$STANDALONE/server.js"
cp -r "$NESTED/.next" "$STANDALONE/.next"
cp -r .next/static "$STANDALONE/.next/static"
cp -r public "$STANDALONE/public"
mkdir -p "$STANDALONE/node_modules/better-sqlite3/build/Release"
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "$STANDALONE/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
```

- [ ] **Step 5: Launch and verify**

```bash
pkill -9 -f "electron" 2>/dev/null
npx electron .
```

Expected: App opens, Analytics link visible in dashboard header, clicking it shows the analytics page with overview cards, trend chart, and tabbed detail section.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete analytics page with all tabs, auto-archive, and daily rollup"
```
