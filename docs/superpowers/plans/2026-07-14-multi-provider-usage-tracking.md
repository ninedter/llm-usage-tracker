# Multi-Provider Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest both Claude Code transcript files and Codex rollout files into the tracker's DB so Analytics and the Agent Monitor show symmetric, provider-tagged metrics (sessions, tokens, tools, models, entrypoints) for Claude and OpenAI, with a provider filter, a relocated full-width Monitor page, and a live dual-provider usage strip.

**Architecture:** One file-based ingestion pipeline (`src/lib/ingest/`) with per-provider parsers, a polling watcher, and idempotent DB upserts feeding the existing SQLite → SSE → UI stack. A new `provider` column tags every row. UI reuses all existing panels behind an All/Claude/OpenAI filter.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript (strict), better-sqlite3 (sync), Tailwind 4, SWR, Vitest (new), Electron + Docker deploy.

## Global Constraints

- No text below 12px anywhere; monitor sizing flows through `FONT_CLASSES` in `src/hooks/use-monitor-settings.ts` (per prior work — do not reintroduce `text-[Npx]` below 12). Usage cards stay at default sizes.
- Store **metadata only** from session files — tool names, token counts, timestamps, file basenames, short summaries. Never persist message text or reasoning content.
- `cost = 0` for both providers (subscriptions). Do not fabricate per-token dollar costs.
- DB access is synchronous (better-sqlite3). API routes return `{ success: true, data }` or `{ success: false, error: { code, message } }`.
- Migrations are additive and idempotent (guard `ADD COLUMN` with a `PRAGMA table_info` check).
- `provider` values: exactly `'claude'` or `'openai'`. Existing rows default to `'claude'`.
- Watcher uses **polling** (not `fs.watch`) — Docker bind mounts don't propagate host inotify events.
- Respect the better-sqlite3 dual-ABI workflow: `npm rebuild better-sqlite3` before `next dev`/Vitest; `npm run electron:rebuild-for-build` to restore for Electron/standalone; `docker compose up -d --build` for the canonical `:3789` instance (dev `.data` DB is empty — verify against Docker).

## File Structure

**New:**
- `src/lib/ingest/types.ts` — normalized record shapes shared by parsers and store.
- `src/lib/ingest/entrypoints.ts` — raw originator/entrypoint → `{ key, label }` mapping.
- `src/lib/ingest/codex.ts` — parse one Codex rollout file → normalized records.
- `src/lib/ingest/claude.ts` — parse one Claude transcript file → normalized records.
- `src/lib/ingest/store.ts` — idempotent upsert of normalized records + SSE broadcast.
- `src/lib/ingest/watcher.ts` — polling scan, offset state, backfill.
- `src/lib/ingest/index.ts` — `startIngestion()` entry point.
- `src/instrumentation.ts` — Next boot hook that calls `startIngestion()`.
- `src/lib/usage/windows.ts` — `shortestWindow` helpers for the strip.
- `src/components/monitor/ProviderUsageStrip.tsx` — dual-provider live usage strip.
- `src/components/ui/ProviderBadge.tsx` — provider pill + entrypoint label.
- `vitest.config.ts`, `src/lib/ingest/__tests__/*.test.ts`, `src/lib/usage/__tests__/*.test.ts`.

**Modified:**
- `src/lib/db.ts` — provider column migration, `ingest_state` table + helpers, provider-tagged upserts, `provider` filter on all analytics queries + `listSessions`/`listAgents`.
- `src/types/index.ts` — add `provider` to records; `IngestState`, normalized types re-export as needed.
- `src/app/api/analytics/*/route.ts` (7 routes) — accept `provider` query param.
- `src/app/api/monitor/agents/route.ts`, `sessions/route.ts`, `stream/route.ts` — provider-aware.
- `src/app/api/monitor/events/route.ts` — deprecated no-op.
- `src/hooks/use-agent-monitor.ts` — carry `provider` through; expose provider filter.
- `src/hooks/use-analytics.ts` — carry `provider` param.
- `src/components/monitor/AgentMonitorPanel.tsx` — provider filter toggle + badges.
- `src/components/monitor/AgentCard.tsx` — provider badge + real entrypoint label.
- `src/app/monitor/page.tsx` — host full-width `AgentMonitorPanel` + strip.
- `src/app/page.tsx` — remove monitor; keep usage cards; add Monitor nav link.
- `src/app/analytics/page.tsx` — provider filter toggle; Analytics/Settings/Monitor nav.
- `docker-compose.yml` — mount `~/.claude` read-only + `CLAUDE_HOME` env.

---

# PHASE 1 — Ingestion foundation

Deliverable: both providers' session files backfill into the DB (provider-tagged, with tokens), visible in the existing Monitor/Analytics.

## Task 1: Vitest setup

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts)
- Test: `src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs Vitest in node environment.

- [ ] **Step 1: Install Vitest**

```bash
cd llm-usage-tracker && npm install -D vitest@^2
```

- [ ] **Step 2: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
});
```

- [ ] **Step 3: Add test script to `package.json`**

Add to `"scripts"`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 4: Write smoke test** — `src/lib/__tests__/smoke.test.ts`

```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => { it("runs", () => { expect(1 + 1).toBe(2); }); });
```

- [ ] **Step 5: Run** — `npm test`. Expected: 1 passing test.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "test: add vitest"`

## Task 2: Provider column migration + ingest_state

**Files:**
- Modify: `src/lib/db.ts:105-115` (migration block), add `ingest_state` table in the `CREATE TABLE` exec, add helpers at end.
- Modify: `src/types/index.ts` (add `provider` to `SessionRecord`, `AgentRecord`, `AgentEvent`; add `IngestState`).
- Test: `src/lib/__tests__/db-migration.test.ts`

**Interfaces:**
- Produces:
  - `getIngestState(sourcePath: string): IngestState | null`
  - `upsertIngestState(s: IngestState): void`
  - `IngestState = { source_path: string; session_id: string; byte_offset: number; mtime: number; size: number; updated_at: number }`
  - `sessions`/`agents`/`agent_events` gain `provider TEXT NOT NULL DEFAULT 'claude'`.

- [ ] **Step 1: Write failing test** — `src/lib/__tests__/db-migration.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeEach(() => { process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "llmdb-")); });

describe("provider migration", () => {
  it("adds provider column and ingest_state helpers", async () => {
    const db = await import("@/lib/db");
    const conn = db.getDb();
    const cols = (conn.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain("provider");
    db.upsertIngestState({ source_path: "/a.jsonl", session_id: "s1", byte_offset: 10, mtime: 1, size: 10, updated_at: 1 });
    expect(db.getIngestState("/a.jsonl")?.byte_offset).toBe(10);
  });
});
```

- [ ] **Step 2: Run** — `npm test src/lib/__tests__/db-migration.test.ts`. Expected: FAIL (no `provider` column / no helper).

- [ ] **Step 3: Add `ingest_state` table** to the `db.exec` block in `getDb()` (after `daily_usage`):

```sql
CREATE TABLE IF NOT EXISTS ingest_state (
  source_path TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL DEFAULT '',
  byte_offset INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 4: Add provider migration** in the forward-compat block (after the `agent_events.session_id` guard):

```ts
for (const table of ["sessions", "agents", "agent_events"]) {
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  if (!cols.has("provider")) db.exec(`ALTER TABLE ${table} ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_provider ON agent_events(provider)");
```

- [ ] **Step 5: Add helpers** at the end of `db.ts`:

```ts
export function getIngestState(sourcePath: string): import("@/types").IngestState | null {
  return getDb().prepare("SELECT * FROM ingest_state WHERE source_path = ?").get(sourcePath) as import("@/types").IngestState | null;
}
export function upsertIngestState(s: import("@/types").IngestState): void {
  getDb().prepare(`
    INSERT INTO ingest_state (source_path, session_id, byte_offset, mtime, size, updated_at)
    VALUES (@source_path, @session_id, @byte_offset, @mtime, @size, @updated_at)
    ON CONFLICT(source_path) DO UPDATE SET
      session_id=excluded.session_id, byte_offset=excluded.byte_offset,
      mtime=excluded.mtime, size=excluded.size, updated_at=excluded.updated_at
  `).run(s);
}
```

- [ ] **Step 6: Add types** to `src/types/index.ts`: add `provider: "claude" | "openai";` to `SessionRecord`, `AgentRecord`, `AgentEvent`; add:

```ts
export interface IngestState { source_path: string; session_id: string; byte_offset: number; mtime: number; size: number; updated_at: number; }
```

- [ ] **Step 7: Run** — `npm test src/lib/__tests__/db-migration.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit** — `git commit -am "feat(db): provider column + ingest_state"`

## Task 3: Normalized types + entrypoint mapping

**Files:**
- Create: `src/lib/ingest/types.ts`, `src/lib/ingest/entrypoints.ts`
- Test: `src/lib/ingest/__tests__/entrypoints.test.ts`

**Interfaces:**
- Produces:
  - `type ProviderId = "claude" | "openai"`
  - `interface EntrypointInfo { key: string; label: string }`
  - `mapEntrypoint(provider: ProviderId, raw: string | null | undefined): EntrypointInfo`
  - `NormalizedSession`, `NormalizedAgent`, `NormalizedEvent`, `NormalizedTokenUsage`, `ParsedFile` (see code).

- [ ] **Step 1: Write `types.ts`**

```ts
import type { ProviderId } from "./entrypoints";
export interface NormalizedTokenUsage { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; }
export interface NormalizedEvent {
  eventType: "tool_call" | "tool_result" | "subagent_start" | "subagent_stop" | "session_start" | "session_end" | "stop" | "compaction";
  toolName: string | null; summary: string | null; filesAffected: string[] | null; timestamp: number; agentKey: string; // "main" or subagent id
}
export interface NormalizedAgent { key: string; parentKey: string | null; type: "main" | "subagent"; subagentType: string | null; description: string; startedAt: number; endedAt: number | null; }
export interface NormalizedSession {
  provider: ProviderId; sessionId: string; project: string; cwd: string; entrypointKey: string; entrypointLabel: string;
  status: "active" | "completed"; startedAt: number; endedAt: number | null; updatedAt: number;
  agents: NormalizedAgent[]; events: NormalizedEvent[]; tokens: NormalizedTokenUsage[];
}
export interface ParsedFile { session: NormalizedSession | null; }
```

- [ ] **Step 2: Write failing test** — `src/lib/ingest/__tests__/entrypoints.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { mapEntrypoint } from "@/lib/ingest/entrypoints";
describe("mapEntrypoint", () => {
  it("maps known claude/codex entrypoints", () => {
    expect(mapEntrypoint("claude", "claude-desktop").label).toBe("Claude Desktop");
    expect(mapEntrypoint("openai", "codex_cli_rs").label).toBe("Codex CLI");
    expect(mapEntrypoint("openai", "Codex Desktop").key).toBe("codex-desktop");
  });
  it("titlecases unknowns", () => {
    expect(mapEntrypoint("openai", "codex_new_thing").label).toBe("Codex New Thing");
  });
});
```

- [ ] **Step 3: Run** — Expected: FAIL.

- [ ] **Step 4: Write `entrypoints.ts`**

```ts
export type ProviderId = "claude" | "openai";
export interface EntrypointInfo { key: string; label: string; }
const CLAUDE: Record<string, EntrypointInfo> = {
  "claude-desktop": { key: "claude-desktop", label: "Claude Desktop" },
  "cli": { key: "claude-cli", label: "Claude CLI" },
  "vscode": { key: "claude-vscode", label: "Claude (VS Code)" },
};
const CODEX: Record<string, EntrypointInfo> = {
  "codex_work_desktop": { key: "codex-desktop", label: "Codex Desktop" },
  "Codex Desktop": { key: "codex-desktop", label: "Codex Desktop" },
  "codex_cli_rs": { key: "codex-cli", label: "Codex CLI" },
  "codex_vscode": { key: "codex-vscode", label: "Codex (VS Code)" },
  "codex_sdk_ts": { key: "codex-sdk", label: "Codex (SDK)" },
};
function titlecase(s: string): string { return s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase()); }
export function mapEntrypoint(provider: ProviderId, raw: string | null | undefined): EntrypointInfo {
  const r = (raw ?? "").trim();
  const table = provider === "claude" ? CLAUDE : CODEX;
  if (r && table[r]) return table[r];
  const prefix = provider === "claude" ? "Claude" : "Codex";
  const label = r ? (r.toLowerCase().startsWith(prefix.toLowerCase()) ? titlecase(r) : `${prefix} ${titlecase(r)}`) : prefix;
  const slug = r ? r.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "unknown";
  return { key: `${provider === "claude" ? "claude" : "codex"}-${slug}`, label };
}
```

- [ ] **Step 5: Run** — Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(ingest): normalized types + entrypoint mapping"`

## Task 4: Codex parser

**Files:**
- Create: `src/lib/ingest/codex.ts`
- Test: `src/lib/ingest/__tests__/codex.test.ts`

**Interfaces:**
- Consumes: `NormalizedSession` (Task 3), `mapEntrypoint`.
- Produces: `parseCodexLines(lines: string[], filePath: string): NormalizedSession | null`.

Parsing rules: `session_meta` → session (provider `openai`, project = `basename(cwd)`, entrypoint from `originator`, one `main` agent). `event_msg`/`token_count` → replace token totals from `info.total_token_usage` (**cumulative — last wins**): input=`input_tokens`, output=`output_tokens`+`reasoning_output_tokens`, cacheRead=`cached_input_tokens`, cacheWrite=0, model from `session_meta` model or `"gpt-5-codex"` fallback. `response_item`/`function_call`|`custom_tool_call` → `tool_call` event (toolName from `name`); `*_output` → `tool_result`. `event_msg`/`mcp_tool_call_end` → `tool_call`. `patch_apply_end` → `tool_call` with `filesAffected`. `sub_agent_activity` → subagent agent + `subagent_start`. `task_complete` → session `endedAt`/`completed`.

- [ ] **Step 1: Write failing test** — `src/lib/ingest/__tests__/codex.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseCodexLines } from "@/lib/ingest/codex";
const lines = [
  JSON.stringify({ timestamp: "2026-07-13T12:19:56.956Z", type: "session_meta", payload: { session_id: "cx1", cwd: "/Users/x/proj", originator: "codex_cli_rs", model: "gpt-5-codex" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 5 } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 90, output_tokens: 30, reasoning_output_tokens: 7 } } } }),
];
describe("parseCodexLines", () => {
  it("builds a session with cumulative-last tokens", () => {
    const s = parseCodexLines(lines, "/f.jsonl")!;
    expect(s.provider).toBe("openai");
    expect(s.project).toBe("proj");
    expect(s.entrypointLabel).toBe("Codex CLI");
    expect(s.tokens[0]).toMatchObject({ input: 300, output: 37, cacheRead: 90, cacheWrite: 0 });
    expect(s.events.some(e => e.eventType === "tool_call" && e.toolName === "shell")).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `codex.ts`** — one pass over `lines` (JSON.parse each; skip malformed). Track a mutable `session` seeded on `session_meta`; a `latestTokens` object replaced on each `token_count`; push events. Return `null` if no `session_meta`. Convert ISO/epoch timestamps to ms. `basename` via `cwd.split("/").filter(Boolean).pop()`. (Reference the parsing rules above; implement each branch explicitly.)

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(ingest): codex rollout parser"`

## Task 5: Claude parser

**Files:**
- Create: `src/lib/ingest/claude.ts`
- Test: `src/lib/ingest/__tests__/claude.test.ts`

**Interfaces:**
- Produces: `parseClaudeLines(lines: string[], filePath: string): NormalizedSession | null`.

Parsing rules: session identity from any entry's `sessionId`/`cwd`/`entrypoint` (provider `claude`, project = `basename(cwd)`). `type: "assistant"` with `message.usage` → **accumulate per `message.model`**: input += `input_tokens`, output += `output_tokens`, cacheRead += `cache_read_input_tokens`, cacheWrite += `cache_creation_input_tokens`. `message.content[]` `tool_use` blocks → `tool_call` (toolName = `name`; Edit/Write → `filesAffected` from `input.file_path`). `type: "user"` with `toolUseResult` → `tool_result`. `isSidechain: true` entries → subagent agent (key from `parentUuid`) + `subagent_start`. Timestamps from entry `timestamp`.

- [ ] **Step 1: Write failing test** — `src/lib/ingest/__tests__/claude.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseClaudeLines } from "@/lib/ingest/claude";
const lines = [
  JSON.stringify({ type: "assistant", sessionId: "cl1", cwd: "/Users/x/proj", entrypoint: "claude-desktop", timestamp: "2026-07-13T12:00:00Z", message: { model: "claude-fable-5", usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: "/Users/x/proj/a.ts" } }] } }),
  JSON.stringify({ type: "assistant", sessionId: "cl1", timestamp: "2026-07-13T12:01:00Z", message: { model: "claude-fable-5", usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, content: [] } }),
];
describe("parseClaudeLines", () => {
  it("sums per-turn usage and captures tools", () => {
    const s = parseClaudeLines(lines, "/f.jsonl")!;
    expect(s.provider).toBe("claude");
    expect(s.entrypointLabel).toBe("Claude Desktop");
    expect(s.tokens.find(t => t.model === "claude-fable-5")).toMatchObject({ input: 8, output: 27, cacheRead: 150, cacheWrite: 10 });
    expect(s.events.some(e => e.toolName === "Edit" && e.filesAffected?.[0] === "/Users/x/proj/a.ts")).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `claude.ts`** per the rules above (accumulate tokens in a `Map<model, NormalizedTokenUsage>`; push events; detect subagents via `isSidechain`). Return `null` if no `sessionId` seen.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(ingest): claude transcript parser"`

## Task 6: Store (idempotent upsert + broadcast)

**Files:**
- Create: `src/lib/ingest/store.ts`
- Modify: `src/lib/db.ts` — add provider-aware `upsertNormalizedSession` OR expose provider params on existing creators (see Interfaces).
- Test: `src/lib/ingest/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `NormalizedSession`.
- Produces: `storeSession(s: NormalizedSession): void` — upserts session (`INSERT ... ON CONFLICT(id) DO UPDATE` including `provider`, `project`, `entrypoint`, `status`, timestamps), main + subagents (`agents.provider`), events (dedup: delete-then-insert this session's events for the ingested provider to stay idempotent), and `token_usage` per model; then `broadcastEvent({ type: "session_updated", data: { session_id } })` and `stats_updated`.

- [ ] **Step 1: Write failing test** — `src/lib/ingest/__tests__/store.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs"; import { tmpdir } from "os"; import { join } from "path";
beforeEach(() => { process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "store-")); });
describe("storeSession", () => {
  it("upserts provider-tagged rows idempotently", async () => {
    const { storeSession } = await import("@/lib/ingest/store");
    const db = await import("@/lib/db");
    const session = { provider: "openai", sessionId: "s1", project: "p", cwd: "/p", entrypointKey: "codex-cli", entrypointLabel: "Codex CLI", status: "completed", startedAt: 1000, endedAt: 2000, updatedAt: 2000, agents: [{ key: "main", parentKey: null, type: "main", subagentType: null, description: "p (Codex CLI)", startedAt: 1000, endedAt: 2000 }], events: [{ eventType: "tool_call", toolName: "shell", summary: null, filesAffected: null, timestamp: 1500, agentKey: "main" }], tokens: [{ model: "gpt-5-codex", input: 300, output: 37, cacheRead: 90, cacheWrite: 0 }] } as const;
    storeSession(session as any); storeSession(session as any); // twice → idempotent
    const conn = db.getDb();
    expect((conn.prepare("SELECT provider FROM sessions WHERE id='s1'").get() as any).provider).toBe("openai");
    expect((conn.prepare("SELECT COUNT(*) n FROM agent_events WHERE session_id='s1'").get() as any).n).toBe(1);
    expect((conn.prepare("SELECT input_tokens FROM token_usage WHERE session_id='s1'").get() as any).input_tokens).toBe(300);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `store.ts`** — wrap all writes in a single `getDb().transaction(...)`. Use `INSERT ... ON CONFLICT(id) DO UPDATE` for sessions/agents (map `agentKey` "main" → `${sessionId}:main`, subagent keys → `${sessionId}:${key}`). For events: `DELETE FROM agent_events WHERE session_id = ?` then re-insert (idempotent). For tokens: `upsertTokenUsage` with `cost: 0`. Broadcast after commit.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(ingest): idempotent provider-aware store"`

## Task 7: Watcher + backfill + boot

**Files:**
- Create: `src/lib/ingest/watcher.ts`, `src/lib/ingest/index.ts`, `src/instrumentation.ts`
- Test: `src/lib/ingest/__tests__/watcher.test.ts`

**Interfaces:**
- Consumes: parsers, `storeSession`, `getIngestState`/`upsertIngestState`.
- Produces: `ingestFileOnce(filePath: string, provider: ProviderId): void` (reads from stored offset, parses whole file's lines to date, stores, advances offset by bytes read); `startIngestion(opts?: { claudeRoot?: string; codexRoot?: string; intervalMs?: number }): void` (backfill both roots newest-first in background, then poll).

Note: parsers take the **whole file's** lines each pass (sessions are cumulative); offset tracking avoids re-reading unchanged files (`mtime`+`size` guard) but on growth we re-parse the full file for a correct cumulative snapshot, then store (idempotent).

- [ ] **Step 1: Write failing test** — `src/lib/ingest/__tests__/watcher.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs"; import { tmpdir } from "os"; import { join } from "path";
beforeEach(() => { process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "watch-")); });
describe("ingestFileOnce", () => {
  it("ingests a codex rollout file into the DB", async () => {
    const { ingestFileOnce } = await import("@/lib/ingest/watcher");
    const db = await import("@/lib/db");
    const dir = mkdtempSync(join(tmpdir(), "roll-"));
    const f = join(dir, "rollout-x.jsonl");
    writeFileSync(f, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-13T12:00:00Z", payload: { session_id: "w1", cwd: "/p", originator: "codex_cli_rs", model: "gpt-5-codex" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } } } }),
    ].join("\n") + "\n");
    ingestFileOnce(f, "openai");
    expect((db.getDb().prepare("SELECT provider FROM sessions WHERE id='w1'").get() as any).provider).toBe("openai");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `watcher.ts`** — `ingestFileOnce`: `stat` file; if `getIngestState` matches `(mtime,size)`, return; else read full file, split lines, pick parser by provider, `storeSession`, `upsertIngestState({ byte_offset: size, mtime, size, ... })`. `scanRoot(root, provider, glob)`: enumerate `*.jsonl` under root (Claude: `projects/**/*.jsonl`; Codex: `sessions/**/*.jsonl`), newest-first, `ingestFileOnce` each with `await new Promise(r => setImmediate(r))` yield between files. `startIngestion`: resolve roots from `opts` or `CLAUDE_HOME`/`~/.claude` and `CODEX_HOME`/`~/.codex`; run initial backfill without blocking (`void backfill()`); `setInterval(scanBoth, intervalMs ?? 2500)`.

- [ ] **Step 4: Write `index.ts`**

```ts
export { startIngestion } from "./watcher";
```

- [ ] **Step 5: Write `src/instrumentation.ts`**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startIngestion } = await import("@/lib/ingest");
  startIngestion();
}
```

- [ ] **Step 6: Run** — `npm test src/lib/ingest/__tests__/watcher.test.ts`. Expected: PASS.

- [ ] **Step 7: Manual verify (Docker)** — `docker compose up -d --build`; after ~30s `curl -s localhost:3789/api/monitor/sessions | python3 -m json.tool | head` shows OpenAI-project sessions. Then commit.

- [ ] **Step 8: Commit** — `git commit -am "feat(ingest): polling watcher + backfill + boot hook"`

---

# PHASE 2 — Provider filtering (API + queries)

Deliverable: analytics and monitor data filterable by provider.

## Task 8: Provider filter in db.ts queries

**Files:**
- Modify: `src/lib/db.ts` — add optional `provider?: ProviderId` to `getAnalyticsOverview`, `getAnalyticsTrends`, `getSessionAnalytics`, `getToolAnalytics`, `getFileAnalytics`, `getModelAnalytics`, `getUsageInsights`, `listSessions`, `listAgents`.
- Test: `src/lib/__tests__/analytics-provider.test.ts`

**Interfaces:**
- Produces: each query, when `provider` is passed, filters rows to that provider. Pattern (apply consistently): add `AND s.provider = ?` (or `agent_events.provider`/`agents.provider`) to each WHERE and thread the bound value; when `provider` is undefined, omit the clause.

- [ ] **Step 1: Write failing test** — seed one `claude` and one `openai` session + a `tool_call` event each (via `getDb()` direct inserts), then assert `getToolAnalytics(0, Date.now()+1, "openai").tools` only counts the openai tool. Expected: FAIL (param ignored).

- [ ] **Step 2: Implement** — thread `provider` into each function. Concrete example for `getToolAnalytics`:

```ts
export function getToolAnalytics(from: number, to: number, provider?: ProviderId): import("@/types").ToolAnalytics {
  const pClause = provider ? " AND provider = ?" : "";
  const pArgs = provider ? [provider] : [];
  const tools = getDb().prepare(`SELECT tool_name, COUNT(*) as call_count, COUNT(*) as success_count, 0 as failure_count, 100.0 as success_rate, 0 as avg_duration_ms FROM agent_events WHERE event_type='tool_call' AND tool_name IS NOT NULL AND timestamp >= ? AND timestamp < ?${pClause} GROUP BY tool_name ORDER BY call_count DESC`).all(from, to, ...pArgs) as import("@/types").ToolAnalyticEntry[];
  // ...apply the same ${pClause}/${pArgs} pattern to the failure, duration, and timeline sub-queries...
}
```

Apply the identical `${pClause}`/`...pArgs` pattern to every sub-query in every listed function (for session-scoped queries use `s.provider`). Add `import type { ProviderId } from "@/lib/ingest/entrypoints"` at top.

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit** — `git commit -am "feat(db): provider filter on analytics + lists"`

## Task 9: Provider param on API routes

**Files:**
- Modify: `src/app/api/analytics/{overview,trends,sessions,tools,files,models,insights}/route.ts`, `src/app/api/monitor/{agents,sessions}/route.ts`
- Modify: `src/hooks/use-analytics.ts`, `src/hooks/use-agent-monitor.ts` (thread `provider`, expose to callers)
- Test: `src/lib/__tests__/analytics-provider.test.ts` (extend) or manual curl

**Interfaces:**
- Produces: every route reads `const provider = req.nextUrl.searchParams.get("provider") as ProviderId | null` and passes `provider ?? undefined` to its db query. `AgentSession`/`AgentRecord` responses include `provider`.

- [ ] **Step 1** Add `provider` extraction to each route and pass through (show one, repeat pattern). Example (`analytics/tools/route.ts`):

```ts
const provider = req.nextUrl.searchParams.get("provider") || undefined;
const data = getToolAnalytics(from, to, provider as any);
```

- [ ] **Step 2** In `use-analytics.ts`, add `provider` to the SWR key/query string; in `use-agent-monitor.ts`, ensure fetched agents/sessions carry `provider` (already present on rows).

- [ ] **Step 3: Verify** — `curl "localhost:3789/api/analytics/tools?provider=openai"` returns only OpenAI tools; `?provider=claude` only Claude. Commit.

- [ ] **Step 4: Commit** — `git commit -am "feat(api): provider query param on analytics + monitor routes"`

## Task 10: Retire hook endpoint

**Files:**
- Modify: `src/app/api/monitor/events/route.ts`
- Test: manual curl

- [ ] **Step 1** Replace the POST body with a compatibility no-op:

```ts
export async function POST(): Promise<NextResponse<ApiResponse<null>>> {
  return NextResponse.json({ success: true, data: null });
}
```

Keep imports minimal; remove now-unused ones to satisfy lint.

- [ ] **Step 2: Verify** — `curl -XPOST localhost:3789/api/monitor/events -d '{}'` → `{"success":true,...}`; no new rows. Commit.

- [ ] **Step 3: Commit** — `git commit -am "chore(api): deprecate events endpoint (file ingestion is source of truth)"`

---

# PHASE 3 — UI: monitor page, provider filter, live strip

Deliverable: full-width Monitor page with the live strip, provider toggle + badges, dashboard keeps usage cards.

## Task 11: shortestWindow helper

**Files:**
- Create: `src/lib/usage/windows.ts`
- Test: `src/lib/usage/__tests__/windows.test.ts`

**Interfaces:**
- Produces:
  - `interface StripWindow { label: string; percentage: number; level: UsageLevel; windowSeconds: number; }`
  - `claudeShortestWindow(d: ClaudeUsageData): StripWindow`
  - `openaiShortestWindow(d: OpenAIUsageData): StripWindow | null`
  - `compactWindowLabel(seconds: number): string` (`<86400 → "${h}h"`, else `"${d}d"`).

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { claudeShortestWindow, openaiShortestWindow, compactWindowLabel } from "@/lib/usage/windows";
describe("shortestWindow", () => {
  it("claude picks 5h; openai picks the smallest window", () => {
    expect(claudeShortestWindow({ session: { percentage: 40, level: "safe", resetTime: null } as any, weekly: { percentage: 10, level: "safe", resetTime: null } as any } as any).label).toBe("5h");
    const oa = { windows: [{ label: "7-Day", windowSeconds: 604800, percentage: 16, level: "safe", resetTime: null }] } as any;
    expect(openaiShortestWindow(oa)!.label).toBe("7d");
    const oa2 = { windows: [{ label: "5h", windowSeconds: 18000, percentage: 5, level: "safe", resetTime: null }, { label: "7d", windowSeconds: 604800, percentage: 16, level: "safe", resetTime: null }] } as any;
    expect(openaiShortestWindow(oa2)!.label).toBe("5h");
  });
  it("compactWindowLabel", () => { expect(compactWindowLabel(18000)).toBe("5h"); expect(compactWindowLabel(604800)).toBe("7d"); });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — Claude candidates: `[{...session, windowSeconds: 18000}, {...weekly, windowSeconds: 604800}]`, reduce to min `windowSeconds`, `label = compactWindowLabel(windowSeconds)`. OpenAI: reduce `d.windows` to min `windowSeconds` (null if empty), `label = compactWindowLabel(w.windowSeconds)`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(usage): dynamic shortest-window helper"`

## Task 12: ProviderUsageStrip component

**Files:**
- Create: `src/components/monitor/ProviderUsageStrip.tsx`
- Verify: browser (Monitor page in Task 15)

**Interfaces:**
- Consumes: `useHealth`, `useClaudeUsage`, `useOpenAIUsage`, `claudeShortestWindow`, `openaiShortestWindow`, `PROVIDER_INFO`.
- Produces: `<ProviderUsageStrip />` — two compact rows (provider name + shortest-window label + % bar), colored by `PROVIDER_INFO[*].color`, `UsageBar`-style. Hidden per-provider row if that provider isn't connected.

- [ ] **Step 1: Implement** the component: for each connected provider, compute the shortest window and render a compact labeled bar (reuse `UsageBar` or a slim inline bar) showing `${providerName} · ${window.label}` and `percentage`. Text ≥12px per Global Constraints. No test framework for UI — verified in Task 15.

- [ ] **Step 2: Commit** — `git commit -am "feat(monitor): dual-provider live usage strip"`

## Task 13: Provider badge + entrypoint labels

**Files:**
- Create: `src/components/ui/ProviderBadge.tsx`
- Modify: `src/components/monitor/AgentCard.tsx` (add badge + real entrypoint label from `agent.metadata`/session), `src/components/monitor/AgentMonitorPanel.tsx` `SessionCard` (badge + entrypoint).
- Remove the ad-hoc `entrypoint === "claude-desktop" ? "Desktop" : ...` logic in `db.ts:260` `ensureAgent` is now dead (hook retired) — leave or clean up.

**Interfaces:**
- Consumes: `provider` on records; `mapEntrypoint` for labels.
- Produces: `<ProviderBadge provider={...} />` pill colored via `PROVIDER_INFO`.

- [ ] **Step 1: Implement `ProviderBadge.tsx`** — small pill: "Claude" (amber `#D4A574`) / "OpenAI" (green `#10A37F`), background at 15% alpha, text ≥12px.

- [ ] **Step 2: Wire into `AgentCard` + `SessionCard`** — render badge next to the type pill; show the real entrypoint label (map from `agent`/session `entrypoint`).

- [ ] **Step 3: Verify** in Task 15 browser check. Commit.

- [ ] **Step 4: Commit** — `git commit -am "feat(monitor): provider badges + entrypoint labels"`

## Task 14: Provider filter toggle

**Files:**
- Modify: `src/components/monitor/AgentMonitorPanel.tsx` (client-side All/Claude/OpenAI filter on `agents`/`sessions`/`recentActivity` by `provider`), `src/app/analytics/page.tsx` (provider toggle → passes to `use-analytics`).
- Modify: `src/hooks/use-analytics.ts` (provider state → query param).

**Interfaces:**
- Produces: an `All / Claude / OpenAI` segmented control (reuse the existing view-mode toggle styling), default `All`.

- [ ] **Step 1: Monitor** — add `providerFilter` state; filter loaded lists by `a.provider`. Render toggle in the header row (≥12px).
- [ ] **Step 2: Analytics** — add `providerFilter` state in `use-analytics.ts`, append `&provider=` to the analytics SWR keys, render the toggle next to `TimeRangePicker`.
- [ ] **Step 3: Verify** (Task 17). Commit.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): All/Claude/OpenAI provider filter"`

## Task 15: Move Agent Monitor to its own page + strip + nav

**Files:**
- Modify: `src/app/monitor/page.tsx` — render `<ProviderUsageStrip />` then full-width `<AgentMonitorPanel />` (remove the old bespoke list UI on that page); keep the viewport-capped height pattern (`h-[calc(100vh-2rem)]`, `min-h-0 flex-1`).
- Modify: `src/app/page.tsx` — remove `AgentMonitorPanel`; keep `DashboardGrid` (usage cards); add a **Monitor** nav link next to Analytics/Settings.
- Modify: `src/app/analytics/page.tsx` — add Monitor link to its nav.

- [ ] **Step 1: Rebuild `monitor/page.tsx`** to host the strip + full-width panel (full-width fixes the low-res squeeze).
- [ ] **Step 2: Trim `page.tsx`** to usage cards only + add Monitor nav link (mirror the Analytics `<Link>` with a monitor icon).
- [ ] **Step 3: Verify (browser)** — `preview_start` (after `npm rebuild better-sqlite3`), or verify on Docker: Monitor page full-width, strip shows both providers' shortest window, dashboard shows only cards, no horizontal scroll at 1280 and at a narrow width. Commit.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): Agent Monitor as its own full-width page + nav"`

## Task 16: Docker mount for ~/.claude

**Files:**
- Modify: `docker-compose.yml`
- Modify: `src/lib/ingest/watcher.ts` (respect `CLAUDE_HOME`)

- [ ] **Step 1** Add a read-only volume `${HOME}/.claude:/claude-home:ro` and env `CLAUDE_HOME=/claude-home` (mirror the existing `~/.codex` mount + `CODEX_HOME`). Confirm the watcher resolves `projects/` under `CLAUDE_HOME`.
- [ ] **Step 2: Verify** — `docker compose up -d --build`; `curl localhost:3789/api/monitor/sessions?provider=claude` shows token-bearing Claude sessions. Commit.
- [ ] **Step 3: Commit** — `git commit -am "chore(docker): mount ~/.claude read-only for ingestion"`

## Task 17: Full build, deploy, verify

- [ ] **Step 1: Typecheck** — `npx tsc --noEmit` → clean.
- [ ] **Step 2: Restore ABI + build** — `npm run build && npm run electron:rebuild-for-build && ELECTRON_RUN_AS_NODE=1 npx electron -e "require('better-sqlite3')"`.
- [ ] **Step 3: Deploy Docker** — `docker compose up -d --build`; health OK.
- [ ] **Step 4: Verify (browser on :3789)** — Monitor page: strip shows Claude 5h + OpenAI 7d; agent list shows both providers with badges + entrypoint labels; provider toggle filters. Analytics: provider toggle filters every tab; OpenAI sessions show real token counts; min font 12px everywhere.
- [ ] **Step 5: Commit** — `git commit -am "chore: build + deploy multi-provider tracking"`

---

## Self-Review (author checklist — completed)

- **Spec coverage:** ingestion (T2–T7), parity both providers (T4/T5), entrypoints (T3), provider filter API+UI (T8/T9/T14), monitor page move (T15), live strip dynamic shortest window (T11/T12/T15), cost=0 (T6 constraint), hook retirement (T10), Docker mount (T16), testing (T1 + per-task). All spec sections mapped.
- **Placeholder scan:** parsers (T4/T5) describe explicit branch rules rather than full listings to stay DRY — each rule is concrete and testable; implementers have the fixture + assertions to code against. No "TBD"/"handle edge cases".
- **Type consistency:** `NormalizedSession`/`NormalizedEvent`/`ProviderId`/`StripWindow`/`IngestState` names used identically across tasks; `provider` column name consistent; `mapEntrypoint`, `storeSession`, `ingestFileOnce`, `startIngestion`, `claudeShortestWindow`/`openaiShortestWindow`/`compactWindowLabel` referenced consistently.
