# Analytics Page — Design Spec

## Overview

Add a dedicated Analytics page (`/analytics`) to the LLM Usage Tracker that provides cost breakdowns, historical trends, tool call analytics, file modification heatmaps, and model usage insights. Includes auto-archival of completed agents from the live monitor.

**Layout:** Hybrid — compact overview dashboard (summary cards + trend chart) at top, tabbed detail section (Sessions / Tools / Files / Models) below. Sticky time-range picker filters everything.

## 1. Data Layer Changes

### 1.1 New Table: `daily_usage`

Stores pre-aggregated daily snapshots for fast trend queries.

```sql
CREATE TABLE IF NOT EXISTS daily_usage (
  date              TEXT NOT NULL,       -- YYYY-MM-DD
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

### 1.2 Rollup Function

A `rollupDailyUsage(date: string)` function in `db.ts` that:
1. Aggregates `token_usage` rows by model and project for that date (using sessions whose `started_at` falls on that date)
2. Counts tool calls/failures from `agent_events` for that date
3. Upserts into `daily_usage` with `ON CONFLICT ... DO UPDATE`

Called from:
- The `/api/monitor/events` POST handler (debounced — at most once per 60 seconds per date)
- The `/api/analytics/*` endpoints as a fallback if today's data is stale

### 1.3 New DB Query Functions

All in `src/lib/db.ts`:

```typescript
// Analytics queries
getOverviewStats(from: number, to: number): OverviewStats
getTrends(from: number, to: number, granularity: 'hourly' | 'daily'): TrendPoint[]
getSessionAnalytics(from: number, to: number, sort: string, order: string): SessionAnalyticRow[]
getToolAnalytics(from: number, to: number): ToolAnalytics
getFileAnalytics(from: number, to: number): FileAnalytics
getModelAnalytics(from: number, to: number): ModelAnalytics
```

### 1.4 Auto-Archive

New agent status: `archived`. Added to the `AgentStatus` type.

`archiveStaleAgents()` function:
- Moves agents with status `completed`/`failed`/`cancelled` where `ended_at < now - 30min` to status `archived`
- Called from `/api/monitor/stats` GET handler (already runs every ~30s)
- Monitor UI filters out `archived` agents from the live view
- Analytics queries include all statuses

### 1.5 New Types

```typescript
interface OverviewStats {
  total_cost: number;
  cost_change_pct: number;       // vs previous equivalent period
  session_count: number;
  avg_session_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  top_model: string;
  top_model_cost_pct: number;
  tool_call_count: number;
  tool_success_rate: number;
}

interface TrendPoint {
  date: string;                  // ISO date or datetime
  cost: number;
  tokens: number;
  sessions: number;
}

interface SessionAnalyticRow {
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

interface ToolAnalyticEntry {
  tool_name: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
}

interface ToolTimelinePoint {
  tool_name: string;
  timestamp: number;
  success: boolean;
  duration_ms: number;
}

interface ToolAnalytics {
  tools: ToolAnalyticEntry[];
  timeline: ToolTimelinePoint[];
}

interface FileEntry {
  file_path: string;
  directory: string;
  file_name: string;
  modification_count: number;
  tools_used: string[];          // e.g. ["Read", "Edit", "Write"]
  tool_breakdown: Record<string, number>; // tool_name -> count
}

interface FileAnalytics {
  files: FileEntry[];
  directories: { directory: string; total_modifications: number }[];
}

interface ModelEntry {
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface ModelTrendPoint {
  date: string;
  model: string;
  cost: number;
  tokens: number;
}

interface ModelAnalytics {
  models: ModelEntry[];
  trend: ModelTrendPoint[];
}
```

## 2. API Routes

All under `src/app/api/analytics/`. All accept `from` and `to` query params (epoch ms). All return `ApiResponse<T>`.

| Route | Method | Returns | Notes |
|-------|--------|---------|-------|
| `/api/analytics/overview` | GET | `OverviewStats` | Computes % change vs previous period |
| `/api/analytics/trends` | GET | `TrendPoint[]` | `granularity` param: `hourly` for <2d range, `daily` otherwise |
| `/api/analytics/sessions` | GET | `SessionAnalyticRow[]` | `sort` (cost/duration/tokens/started_at), `order` (asc/desc), `limit`, `offset` |
| `/api/analytics/tools` | GET | `ToolAnalytics` | Includes both ranked list and timeline points |
| `/api/analytics/files` | GET | `FileAnalytics` | Parses `files_affected` JSON from events, groups by directory |
| `/api/analytics/models` | GET | `ModelAnalytics` | Includes per-model totals and daily time series |

## 3. Frontend Components

### 3.1 Page: `/analytics` (`src/app/analytics/page.tsx`)

Top-level layout:
1. **Header** — title, subtitle, time-range picker, back-to-dashboard link
2. **Overview section** — 5 summary cards + trend chart
3. **Detail section** — tabbed container (Sessions / Tools / Files / Models)

### 3.2 Time Range Picker (`src/components/analytics/TimeRangePicker.tsx`)

- Preset buttons: Today, 7d, 30d, All
- Custom date picker (two date inputs)
- Computes `from`/`to` epoch timestamps
- Sticky positioned at top
- Passes `{ from, to }` up to parent via callback

### 3.3 Overview Cards (`src/components/analytics/OverviewCards.tsx`)

5 cards in a grid:
1. **Total Cost** — dollar amount + red/green % change badge
2. **Sessions** — count + "avg Xm per session"
3. **Tokens Used** — formatted total + "XK input / YK output" subtitle
4. **Top Model** — model name + "X% of total cost"
5. **Tool Calls** — count + "X% success rate"

Uses SWR to fetch `/api/analytics/overview`.

### 3.4 Trend Chart (`src/components/analytics/TrendChart.tsx`)

Dual bar chart rendered with pure CSS/HTML (no chart library — consistent with existing app approach):
- Green bars for cost, blue bars for token volume
- X-axis labels adapt to granularity (hours or dates)
- Hover tooltips showing exact values
- Legend in top-right

Uses SWR to fetch `/api/analytics/trends`.

### 3.5 Sessions Tab (`src/components/analytics/SessionsTable.tsx`)

Sortable table with columns: Project, Duration, Tokens, Cost, Tools, Status.
- Click column headers to sort
- Status badges (active = green, completed = gray, error = red, abandoned = amber)
- Pagination (20 per page)

Uses SWR to fetch `/api/analytics/sessions`.

### 3.6 Tools Tab (`src/components/analytics/ToolsPanel.tsx`)

Four sections:
1. **Most Used Tools** — horizontal bar chart, ranked by call count, each tool gets a distinct color
2. **Success / Failure Rate** — stacked green/red bars per tool with percentage label
3. **Tool Call Timeline** — swim lane visualization, one row per tool, dots/bars positioned by timestamp, color = success/failure, wider bars = longer duration (Agent, Bash)
4. **Average Duration** — 4 cards showing slowest → fastest tools

Uses SWR to fetch `/api/analytics/tools`.

### 3.7 Files Tab (`src/components/analytics/FilesPanel.tsx`)

Three sections:
1. **Modification Heatmap** — grid of squares grouped by directory, purple intensity = edit frequency (GitHub contribution graph style)
2. **Most Modified Files** — ranked list with file name, count, and tool badges (Read/Edit/Write/Grep)
3. **Per-File Tool Breakdown** — stacked bar showing tool proportion for the selected/top file

Uses SWR to fetch `/api/analytics/files`.

### 3.8 Models Tab (`src/components/analytics/ModelsPanel.tsx`)

Three sections:
1. **Cost by Model** — SVG donut chart with total in center, legend with dollar amounts
2. **Token Breakdown** — per-model stacked bars (input/output/cache_read/cache_write)
3. **Model Usage Over Time** — stacked bar chart, one color per model, daily granularity

Uses SWR to fetch `/api/analytics/models`.

### 3.9 Analytics Hook (`src/hooks/use-analytics.ts`)

Shared hook providing:
- `timeRange` state: `{ from: number, to: number, preset: string }`
- `setPreset(preset)` and `setCustomRange(from, to)` functions
- All SWR fetches keyed on `from`/`to` so they refetch when range changes
- `revalidateOnFocus: false`, `refreshInterval: 60_000` (analytics doesn't need real-time)

## 4. Navigation Changes

### 4.1 Dashboard Link

Add "Analytics" link to the main dashboard header (next to the Settings link):
- Icon: bar chart icon
- Links to `/analytics`

### 4.2 Analytics Back Link

Analytics page has a "Dashboard" back link in its header (same pattern as Settings page).

### 4.3 Monitor Auto-Archive Integration

In `use-agent-monitor.ts`, filter out agents with `status === 'archived'` from all computed lists. No UI change needed — archived agents simply disappear from the live view after 30 minutes.

## 5. Styling

All new components follow existing conventions:
- Dark theme: zinc-900/950 backgrounds, zinc-800 borders
- Accent colors: emerald for success/cost, amber for warnings, red for failures, violet/purple for primary accents
- Tailwind CSS 4 utility classes
- Same font size system as monitor (inherits from page, not configurable separately)
- Responsive grid that works within the Electron window (min-width 800px)

## 6. Charting Approach

Pure CSS/HTML rendering for all charts — no external charting library. This is consistent with the existing app which uses no third-party UI libraries beyond Tailwind. Charts are built with:
- CSS `flex` + percentage widths for bar charts
- SVG for the donut chart (simple `stroke-dasharray` circles)
- CSS `position: absolute` with percentage `left` for timeline positioning
- Hover states via Tailwind `group-hover` for tooltips

## 7. Auto-Archive Behavior

| Current Status | After 30 min idle | Effect |
|---|---|---|
| `completed` | → `archived` | Removed from monitor, visible in analytics |
| `failed` | → `archived` | Same |
| `cancelled` | → `archived` | Same |
| `working` | No change | Stays in monitor |
| `idle` | No change | Stays in monitor |

The 30-minute threshold is a constant in `src/lib/constants.ts`: `ARCHIVE_AFTER_MS = 30 * 60 * 1000`.

## 8. File Structure

New files to create:
```
src/app/analytics/page.tsx
src/app/api/analytics/overview/route.ts
src/app/api/analytics/trends/route.ts
src/app/api/analytics/sessions/route.ts
src/app/api/analytics/tools/route.ts
src/app/api/analytics/files/route.ts
src/app/api/analytics/models/route.ts
src/components/analytics/TimeRangePicker.tsx
src/components/analytics/OverviewCards.tsx
src/components/analytics/TrendChart.tsx
src/components/analytics/SessionsTable.tsx
src/components/analytics/ToolsPanel.tsx
src/components/analytics/FilesPanel.tsx
src/components/analytics/ModelsPanel.tsx
src/hooks/use-analytics.ts
```

Files to modify:
```
src/lib/db.ts                    — new table, indexes, query functions, rollup, archive
src/types/index.ts               — new analytics types, archived status
src/app/page.tsx                 — add Analytics nav link
src/hooks/use-agent-monitor.ts   — filter archived agents
src/lib/constants.ts             — ARCHIVE_AFTER_MS constant
src/app/api/monitor/stats/route.ts — call archiveStaleAgents()
src/app/api/monitor/events/route.ts — trigger debounced rollup
```
