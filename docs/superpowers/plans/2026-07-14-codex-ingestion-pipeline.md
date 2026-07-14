# Codex Ingestion Pipeline Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Codex CLI rollout logs (`~/.codex/sessions/**/rollout-*.jsonl`) into the existing `sessions`/`agents`/`agent_events`/`token_usage` tables so OpenAI/Codex activity appears in the monitor and analytics, with a 90-day backfill plus near-real-time live tailing.

**Architecture:** A pure mapper (`codex-rollout.ts`) turns rollout JSONL records into normalized events; an idempotent writer (`codex-ingest.ts`) persists them with real historical timestamps and a per-file cursor; a polling watcher (`codex-watcher.ts`), started from `instrumentation.ts` on server boot, backfills the last 90 days then tails for new bytes every ~4s. All data lands in the current SQLite schema (extended with a `provider` column and event dedup).

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, `better-sqlite3` (synchronous), Vitest, Node `fs`/`readline`.

## Global Constraints

- Provider vocabulary is the existing `ProviderId` type: `"claude" | "openai"`. The DB `provider` column defaults to `"claude"`; Codex rows are `"openai"`. (This supersedes the spec's `"anthropic"` wording for consistency with existing code.)
- All Codex-derived DB ids are prefixed `codex:` (e.g. session id `codex:<root-thread-id>`) to avoid PK collision with Claude UUIDs.
- `~/.codex` is **read-only** — never write back to it. Cursor state lives in the app DB only.
- Codex runs on a flat subscription: `token_usage.cost` for Codex rows is always `0` (no fabricated dollars).
- `better-sqlite3` is synchronous — no `await` on DB calls.
- API-route response shape stays `{ success, data }` / `{ success, error: { code, message } }`.
- Never crash the server from ingestion: every watcher/parse path catches and logs.
- Path alias: `@/*` → `src/*`. Tests live in `src/lib/__tests__/`. Test command: `npx vitest run <file>`.
- Reuse existing db helpers and `broadcastEvent` from `@/lib/ws`; do not add new deps.

## Codex rollout format reference (observed 2026-07-14)

Every line is a JSON record with top-level `{ timestamp: ISO8601, type, payload }`.

- Top-level `type`: `session_meta`, `turn_context`, `event_msg`, `response_item`, `compacted`, `world_state`, `inter_agent_communication_metadata`.
- `session_meta.payload`: `session_id`, `id`, `parent_thread_id`, `forked_from_id`, `cwd`, `originator` (e.g. `codex_work_desktop`), `cli_version`, `thread_source` (`"subagent"` or absent for root), `source.subagent.thread_spawn.{parent_thread_id, depth, agent_path, agent_nickname}`, `agent_nickname`.
- `turn_context.payload`: `model` (e.g. `gpt-5.6-sol`), `cwd`, `turn_id`.
- `event_msg.payload.type`:
  - `mcp_tool_call_end`: `call_id`, `invocation.{server, tool, arguments}`, `duration.{secs, nanos}`, `result.Ok.{isError}` | `result.Err`.
  - `patch_apply_end`: `call_id`, `success` (bool), `changes: { "<abs path>": {type, content} }`.
  - `web_search_end`: `call_id`, `query`.
  - `token_count`: `info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens}`.
  - `context_compacted`.
  - `task_complete`: `turn_id`.
  - (skipped) `agent_reasoning`, `agent_message`, `user_message`, `sub_agent_activity`, `thread_settings_applied`.
- `response_item.payload.type`:
  - `custom_tool_call`: `call_id`, `name` (e.g. `exec`), `input` (string).
  - `custom_tool_call_output`: `call_id`, `output`, `status`.
  - (skipped) `message`, `reasoning`, `agent_message`.

---

## Task 1: Schema — provider column, event dedup, cursor table, db helpers

**Files:**
- Modify: `src/types/index.ts` (add `provider` / `source_id` to record interfaces)
- Modify: `src/lib/db.ts` (schema, migrations, helpers)
- Test: `src/lib/__tests__/db-provider.test.ts`

**Interfaces:**
- Consumes: existing `getDb`, `createEvent`, `createSession`, `createAgent`, `upsertTokenUsage` in `src/lib/db.ts`; `ProviderId`, `AgentEvent` in `src/types`.
- Produces:
  - `SessionRecord`, `AgentRecord`, `AgentEvent`, `TokenUsage` each gain `provider: ProviderId`. `AgentEvent` also gains `source_id: string | null`.
  - `createSession(session, provider?: ProviderId)` — default `"claude"`.
  - `createAgent(agent, provider?: ProviderId)` — default `"claude"`.
  - `upsertTokenUsage(usage, provider?: ProviderId)` — default `"claude"`.
  - `insertCodexEvent(event: CodexEventInsert, sourceId: string): AgentEvent | null` where `CodexEventInsert = { agent_id: string; session_id: string; event_type: AgentEventType; tool_name: string | null; summary: string | null; content: string | null; files_affected: string | null; timestamp: number }`. Returns the inserted `AgentEvent`, or `null` if `sourceId` already existed (so the caller can broadcast exactly the new row).
  - `CodexCursor = { file_path: string; byte_offset: number; line_offset: number; thread_id: string | null; session_id: string | null; agent_id: string | null; status: string; last_seen_at: number }`.
  - `getCodexCursor(filePath: string): CodexCursor | null`.
  - `upsertCodexCursor(cursor: CodexCursor): void`.
  - `closeDb(): void` — resets the singleton (test isolation).

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/db-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dataDir: string;
let db: typeof import("@/lib/db");

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "llm-db-"));
  process.env.LLM_DATA_DIR = dataDir;
  db = await import("@/lib/db");
  db.closeDb();
});

afterEach(() => {
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("provider schema", () => {
  it("defaults existing sessions to claude and tags codex sessions openai", () => {
    db.createSession({
      id: "s-claude", status: "active", project: "p", cwd: "/p",
      entrypoint: "cli", started_at: 1, ended_at: null, metadata: null,
    });
    db.createSession({
      id: "codex:s1", status: "active", project: "p", cwd: "/p",
      entrypoint: "codex-desktop", started_at: 1, ended_at: null, metadata: null,
    }, "openai");

    const rows = db.getDb().prepare("SELECT id, provider FROM sessions ORDER BY id").all() as { id: string; provider: string }[];
    expect(rows).toEqual([
      { id: "codex:s1", provider: "openai" },
      { id: "s-claude", provider: "claude" },
    ]);
  });

  it("dedupes codex events by source_id", () => {
    const ev = {
      agent_id: "codex:a1", session_id: "codex:s1", event_type: "tool_call" as const,
      tool_name: "exec", summary: null, content: null, files_affected: null, timestamp: 100,
    };
    expect(db.insertCodexEvent(ev, "call-1:call")).toBeTruthy();
    expect(db.insertCodexEvent(ev, "call-1:call")).toBeNull();
    const n = db.getDb().prepare("SELECT COUNT(*) as n FROM agent_events").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("round-trips a codex cursor", () => {
    db.upsertCodexCursor({
      file_path: "/x/rollout-a.jsonl", byte_offset: 42, line_offset: 3,
      thread_id: "t1", session_id: "codex:s1", agent_id: "codex:a1",
      status: "active", last_seen_at: 999,
    });
    db.upsertCodexCursor({
      file_path: "/x/rollout-a.jsonl", byte_offset: 88, line_offset: 6,
      thread_id: "t1", session_id: "codex:s1", agent_id: "codex:a1",
      status: "active", last_seen_at: 1000,
    });
    const c = db.getCodexCursor("/x/rollout-a.jsonl");
    expect(c?.byte_offset).toBe(88);
    expect(c?.line_offset).toBe(6);
    expect(db.getCodexCursor("/missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/db-provider.test.ts`
Expected: FAIL — `closeDb`, `insertCodexEvent`, `getCodexCursor`, `upsertCodexCursor` are not exported (and `provider` column missing).

- [ ] **Step 3: Add `provider` / `source_id` to the type interfaces**

In `src/types/index.ts`, add `provider: ProviderId;` to `SessionRecord`, `AgentRecord`, and `TokenUsage`. Update `AgentEvent` to add both fields:

```ts
export interface AgentEvent {
  id: number;
  agent_id: string;
  session_id: string;
  event_type: AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string | null; // JSON array string
  timestamp: number;
  created_at: number;
  provider: ProviderId;
  source_id: string | null;
}
```

- [ ] **Step 4: Extend the schema, migrations, and helpers in `db.ts`**

In `src/lib/db.ts`:

(a) Add `provider TEXT NOT NULL DEFAULT 'claude'` to the `sessions`, `agents`, `agent_events`, and `token_usage` `CREATE TABLE` statements. Add `source_id TEXT` to `agent_events`. After the existing `CREATE INDEX` block, add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_id ON agent_events(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_events_provider ON agent_events(provider);

CREATE TABLE IF NOT EXISTS codex_ingest (
  file_path    TEXT PRIMARY KEY,
  byte_offset  INTEGER NOT NULL DEFAULT 0,
  line_offset  INTEGER NOT NULL DEFAULT 0,
  thread_id    TEXT,
  session_id   TEXT,
  agent_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
```

(b) In the forward-migration block (after the existing `agent_events` `session_id` migration, ~line 113), add idempotent column adds:

```ts
const addCol = (table: string, col: string, ddl: string) => {
  const cols = db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === col)) db!.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};
for (const t of ["sessions", "agents", "agent_events", "token_usage"]) {
  addCol(t, "provider", "provider TEXT NOT NULL DEFAULT 'claude'");
}
addCol("agent_events", "source_id", "source_id TEXT");
```

(c) Add `provider` params to the three creators (default `"claude"`), naming the column explicitly in each `INSERT`. For `createSession`:

```ts
export function createSession(session: Omit<SessionRecord, "updated_at" | "provider">, provider: ProviderId = "claude"): SessionRecord {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO sessions (id, status, project, cwd, entrypoint, started_at, ended_at, updated_at, metadata, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, session.status, session.project, session.cwd, session.entrypoint, session.started_at, session.ended_at, now, session.metadata, provider);
  return { ...session, updated_at: now, provider };
}
```

Apply the same pattern to the other two creators, with these exact signatures (note each `Omit` also excludes `provider`):

- `createAgent(agent: Omit<AgentRecord, "created_at" | "provider">, provider: ProviderId = "claude"): AgentRecord` — add `provider` to the INSERT column list + value; `return { ...agent, created_at: now, provider }`.
- `upsertTokenUsage(usage: Omit<TokenUsage, "provider">, provider: ProviderId = "claude"): void` — add `provider` to the INSERT column list + value; the `ON CONFLICT` update list does **not** change.

Update the existing `createEvent` return object to include `provider: "claude", source_id: null` so it satisfies the widened `AgentEvent` type (its INSERT is unchanged — the column default supplies `'claude'`).

(d) Add the Codex helpers at the end of the file:

```ts
export interface CodexCursor {
  file_path: string;
  byte_offset: number;
  line_offset: number;
  thread_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  status: string;
  last_seen_at: number;
}

export interface CodexEventInsert {
  agent_id: string;
  session_id: string;
  event_type: import("@/types").AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string | null;
  timestamp: number;
}

export function insertCodexEvent(event: CodexEventInsert, sourceId: string): AgentEvent | null {
  const now = Date.now();
  const res = getDb().prepare(`
    INSERT OR IGNORE INTO agent_events
      (agent_id, session_id, event_type, tool_name, summary, content, files_affected, timestamp, created_at, provider, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'openai', ?)
  `).run(
    event.agent_id, event.session_id, event.event_type, event.tool_name,
    event.summary, event.content, event.files_affected, event.timestamp, now, sourceId
  );
  if (res.changes === 0) return null; // duplicate source_id — already ingested
  return {
    id: Number(res.lastInsertRowid),
    agent_id: event.agent_id, session_id: event.session_id, event_type: event.event_type,
    tool_name: event.tool_name, summary: event.summary, content: event.content,
    files_affected: event.files_affected, timestamp: event.timestamp,
    created_at: now, provider: "openai", source_id: sourceId,
  };
}

export function getCodexCursor(filePath: string): CodexCursor | null {
  return getDb().prepare("SELECT * FROM codex_ingest WHERE file_path = ?").get(filePath) as CodexCursor | null;
}

export function upsertCodexCursor(c: CodexCursor): void {
  getDb().prepare(`
    INSERT INTO codex_ingest (file_path, byte_offset, line_offset, thread_id, session_id, agent_id, status, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      line_offset = excluded.line_offset,
      thread_id = excluded.thread_id,
      session_id = excluded.session_id,
      agent_id = excluded.agent_id,
      status = excluded.status,
      last_seen_at = excluded.last_seen_at
  `).run(c.file_path, c.byte_offset, c.line_offset, c.thread_id, c.session_id, c.agent_id, c.status, c.last_seen_at);
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/db-provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` — Expected: no errors.

```bash
git add src/types/index.ts src/lib/db.ts src/lib/__tests__/db-provider.test.ts
git commit -m "feat(db): provider column, codex event dedup, ingest cursor table"
```

---

## Task 2: Pure Codex rollout mapper

**Files:**
- Create: `src/lib/providers/codex-rollout.ts`
- Test: `src/lib/__tests__/codex-rollout.test.ts`

**Interfaces:**
- Consumes: `AgentEventType`, `ProviderId` from `@/types`.
- Produces:

```ts
export interface CodexMappedEvent {
  event_type: AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string[];
  timestamp: number;   // epoch ms
  source_id: string;   // deterministic, stable across re-reads
}
export interface CodexSessionInfo {
  thread_id: string;
  root_id: string;        // root ancestor thread id (== thread_id for main)
  is_subagent: boolean;
  project: string;        // basename(cwd)
  cwd: string;
  entrypoint: string;     // e.g. "codex-desktop"
  description: string;
  started_at: number;
}
export interface CodexTokenTotals {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}
export function parseRolloutLines(text: string): unknown[];           // JSONL → records, skips malformed
export function readSessionInfo(records: unknown[]): CodexSessionInfo | null;  // from session_meta (+ turn_context cwd fallback)
export function mapEventRecord(record: unknown, threadId: string): CodexMappedEvent[];  // 0..2 events
export function readTokenTotals(records: unknown[]): CodexTokenTotals | null;  // last token_count + last turn_context model
```

- Ids: `sessionDbId = "codex:" + root_id`, `agentDbId = "codex:" + thread_id`. The mapper returns raw thread ids in `CodexSessionInfo`; the `codex:` prefixing happens in the ingest layer (Task 3).
- Naming: `mcp__{server}__{tool}`, `exec`, `apply_patch`, `web_search`.
- `source_id`: tool events use the payload `call_id` (`:call` / `:result` suffixes); `task_complete` uses `turn_id`; `context_compacted` uses `threadId + ":compact:" + timestamp`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/codex-rollout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseRolloutLines, readSessionInfo, mapEventRecord, readTokenTotals,
} from "@/lib/providers/codex-rollout";

const T = "2026-07-14T06:00:00.000Z";
const TMS = Date.parse(T);
const rec = (payload: object, type = "event_msg", timestamp = T) => ({ timestamp, type, payload });

describe("parseRolloutLines", () => {
  it("parses valid lines and skips malformed", () => {
    const text = `${JSON.stringify(rec({ type: "context_compacted" }))}\nnot json\n\n${JSON.stringify(rec({ type: "task_complete", turn_id: "x" }))}`;
    expect(parseRolloutLines(text)).toHaveLength(2);
  });
});

describe("readSessionInfo", () => {
  it("reads a root session from session_meta", () => {
    const meta = rec({
      session_id: "root-1", id: "root-1", cwd: "/Users/me/proj",
      originator: "codex_work_desktop", cli_version: "0.1",
    }, "session_meta");
    const info = readSessionInfo([meta])!;
    expect(info.thread_id).toBe("root-1");
    expect(info.root_id).toBe("root-1");
    expect(info.is_subagent).toBe(false);
    expect(info.project).toBe("proj");
    expect(info.entrypoint).toBe("codex-desktop");
    expect(info.started_at).toBe(TMS);
  });

  it("detects a subagent thread and its parent", () => {
    const meta = rec({
      session_id: "sub-9", id: "sub-9", parent_thread_id: "root-1",
      cwd: "/Users/me/proj", thread_source: "subagent",
      source: { subagent: { thread_spawn: { parent_thread_id: "root-1", depth: 2, agent_path: "/root/x", agent_nickname: "Hilbert" } } },
    }, "session_meta");
    const info = readSessionInfo([meta])!;
    expect(info.is_subagent).toBe(true);
    expect(info.root_id).toBe("root-1");
    expect(info.description).toContain("Hilbert");
  });
});

describe("mapEventRecord", () => {
  it("maps mcp_tool_call_end to a tool_call + tool_result", () => {
    const r = rec({
      type: "mcp_tool_call_end", call_id: "c1",
      invocation: { server: "node_repl", tool: "js", arguments: { code: "1" } },
      duration: { secs: 0, nanos: 500000000 },
      result: { Ok: { isError: false } },
    });
    const evs = mapEventRecord(r, "t1");
    expect(evs.map(e => e.event_type)).toEqual(["tool_call", "tool_result"]);
    expect(evs[0].tool_name).toBe("mcp__node_repl__js");
    expect(evs[0].source_id).toBe("c1:call");
    expect(evs[1].source_id).toBe("c1:result");
    expect(evs[0].timestamp).toBe(TMS - 500); // start = end - duration
    expect(evs[1].timestamp).toBe(TMS);
    expect(evs[1].summary).not.toMatch(/error/i);
  });

  it("marks mcp tool_result as error when isError", () => {
    const r = rec({ type: "mcp_tool_call_end", call_id: "c2", invocation: { server: "s", tool: "t", arguments: {} }, duration: { secs: 0, nanos: 0 }, result: { Ok: { isError: true } } });
    const evs = mapEventRecord(r, "t1");
    expect(evs[1].summary).toMatch(/error/i);
  });

  it("maps patch_apply_end to file events with affected paths", () => {
    const r = rec({
      type: "patch_apply_end", call_id: "p1", success: true,
      changes: { "/a/b.js": { type: "add" }, "/a/c.js": { type: "update" } },
    });
    const evs = mapEventRecord(r, "t1");
    expect(evs[0].tool_name).toBe("apply_patch");
    expect(evs[0].files_affected.sort()).toEqual(["/a/b.js", "/a/c.js"]);
    expect(evs[1].event_type).toBe("tool_result");
  });

  it("maps a custom_tool_call exec to a tool_call", () => {
    const r = rec({ type: "custom_tool_call", call_id: "e1", name: "exec", input: "tools.exec_command({cmd:'ls'})" }, "response_item");
    const evs = mapEventRecord(r, "t1");
    expect(evs).toHaveLength(1);
    expect(evs[0].event_type).toBe("tool_call");
    expect(evs[0].tool_name).toBe("exec");
    expect(evs[0].source_id).toBe("e1:call");
  });

  it("maps custom_tool_call_output to a tool_result", () => {
    const r = rec({ type: "custom_tool_call_output", call_id: "e1", status: "completed", output: "ok" }, "response_item");
    const evs = mapEventRecord(r, "t1");
    expect(evs[0].event_type).toBe("tool_result");
    expect(evs[0].tool_name).toBe("exec");
    expect(evs[0].source_id).toBe("e1:result");
  });

  it("maps web_search_end, context_compacted, task_complete", () => {
    expect(mapEventRecord(rec({ type: "web_search_end", call_id: "w1", query: "q" }), "t1")[0].tool_name).toBe("web_search");
    expect(mapEventRecord(rec({ type: "context_compacted" }), "t1")[0].event_type).toBe("compaction");
    expect(mapEventRecord(rec({ type: "task_complete", turn_id: "turn-9" }), "t1")[0].source_id).toBe("turn-9");
    expect(mapEventRecord(rec({ type: "task_complete", turn_id: "turn-9" }), "t1")[0].event_type).toBe("stop");
  });

  it("returns [] for skipped record types", () => {
    expect(mapEventRecord(rec({ type: "agent_reasoning" }), "t1")).toEqual([]);
    expect(mapEventRecord(rec({ type: "user_message" }), "t1")).toEqual([]);
  });
});

describe("readTokenTotals", () => {
  it("takes the last cumulative total and the model", () => {
    const records = [
      { timestamp: T, type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/p" } },
      { timestamp: T, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } } } },
      { timestamp: T, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 12, output_tokens: 7 } } } },
    ];
    const tot = readTokenTotals(records)!;
    expect(tot).toEqual({ model: "gpt-5.6-sol", input_tokens: 30, output_tokens: 7, cache_read_tokens: 12, cache_write_tokens: 0 });
  });

  it("returns null when there is no token_count", () => {
    expect(readTokenTotals([{ timestamp: T, type: "turn_context", payload: { model: "m" } }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/codex-rollout.test.ts`
Expected: FAIL — module `@/lib/providers/codex-rollout` not found.

- [ ] **Step 3: Write the mapper**

Create `src/lib/providers/codex-rollout.ts`:

```ts
import type { AgentEventType } from "@/types";

export interface CodexMappedEvent {
  event_type: AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string[];
  timestamp: number;
  source_id: string;
}
export interface CodexSessionInfo {
  thread_id: string;
  root_id: string;
  is_subagent: boolean;
  project: string;
  cwd: string;
  entrypoint: string;
  description: string;
  started_at: number;
}
export interface CodexTokenTotals {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface Rec { timestamp?: string; type?: string; payload?: Record<string, unknown> }

const asRec = (x: unknown): Rec => (x && typeof x === "object" ? (x as Rec) : {});
const ms = (r: Rec): number => (r.timestamp ? Date.parse(r.timestamp) : 0);
const basename = (p: string): string => p.split("/").filter(Boolean).pop() || p;

export function parseRolloutLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return out;
}

export function readSessionInfo(records: unknown[]): CodexSessionInfo | null {
  const metaRec = records.map(asRec).find(r => r.type === "session_meta");
  if (!metaRec) return null;
  const p = metaRec.payload ?? {};
  const thread_id = String(p.id ?? p.session_id ?? "");
  if (!thread_id) return null;

  const subagent = (p.source as { subagent?: { thread_spawn?: Record<string, unknown> } } | undefined)?.subagent;
  const spawn = subagent?.thread_spawn ?? {};
  const is_subagent = p.thread_source === "subagent" || subagent != null;
  const root_id = String(p.parent_thread_id ?? spawn.parent_thread_id ?? thread_id);

  const cwd = String(p.cwd ?? "");
  const originator = String(p.originator ?? "");
  const entrypoint = originator.replace(/_/g, "-").replace(/^codex-work-/, "codex-").replace(/^codex-/, "codex-") || "codex";
  const nickname = String(p.agent_nickname ?? spawn.agent_nickname ?? "");
  const agentPath = String(spawn.agent_path ?? "");
  const description = is_subagent
    ? `Codex subagent${nickname ? ` (${nickname})` : ""}${agentPath ? `: ${agentPath}` : ""}`
    : `${basename(cwd) || "codex"} (Codex)`;

  return {
    thread_id, root_id, is_subagent,
    project: basename(cwd), cwd,
    entrypoint: entrypoint.startsWith("codex") ? entrypoint : `codex-${entrypoint}`,
    description, started_at: ms(metaRec),
  };
}

export function readTokenTotals(records: unknown[]): CodexTokenTotals | null {
  let model = "codex";
  let totals: { input_tokens: number; output_tokens: number; cache_read_tokens: number } | null = null;
  for (const raw of records) {
    const r = asRec(raw);
    const p = r.payload ?? {};
    if (r.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (p.type === "token_count") {
      const info = (p.info as { total_token_usage?: Record<string, number> } | undefined)?.total_token_usage;
      if (info) totals = {
        input_tokens: info.input_tokens ?? 0,
        output_tokens: info.output_tokens ?? 0,
        cache_read_tokens: info.cached_input_tokens ?? 0,
      };
    }
  }
  if (!totals) return null;
  return { model, ...totals, cache_write_tokens: 0 };
}

export function mapEventRecord(record: unknown, threadId: string): CodexMappedEvent[] {
  const r = asRec(record);
  const p = r.payload ?? {};
  const t = String(p.type ?? "");
  const at = ms(r);
  const base = (over: Partial<CodexMappedEvent>): CodexMappedEvent => ({
    event_type: "tool_call", tool_name: null, summary: null, content: null,
    files_affected: [], timestamp: at, source_id: "", ...over,
  });

  switch (t) {
    case "mcp_tool_call_end": {
      const callId = String(p.call_id ?? "");
      const inv = (p.invocation as { server?: string; tool?: string } | undefined) ?? {};
      const name = `mcp__${inv.server ?? "unknown"}__${inv.tool ?? "unknown"}`;
      const dur = (p.duration as { secs?: number; nanos?: number } | undefined) ?? {};
      const durMs = Math.round((dur.secs ?? 0) * 1000 + (dur.nanos ?? 0) / 1e6);
      const result = p.result as { Ok?: { isError?: boolean }; Err?: unknown } | undefined;
      const isError = result?.Err != null || result?.Ok?.isError === true;
      return [
        base({ event_type: "tool_call", tool_name: name, timestamp: at - durMs, summary: name, source_id: `${callId}:call` }),
        base({ event_type: "tool_result", tool_name: name, summary: isError ? "error" : "ok", source_id: `${callId}:result` }),
      ];
    }
    case "patch_apply_end": {
      const callId = String(p.call_id ?? "");
      const changes = (p.changes as Record<string, unknown> | undefined) ?? {};
      const files = Object.keys(changes);
      const ok = p.success === true;
      return [
        base({ event_type: "tool_call", tool_name: "apply_patch", files_affected: files, summary: `apply_patch (${files.length} file${files.length === 1 ? "" : "s"})`, source_id: `${callId}:call` }),
        base({ event_type: "tool_result", tool_name: "apply_patch", files_affected: files, summary: ok ? "ok" : "error", source_id: `${callId}:result` }),
      ];
    }
    case "web_search_end": {
      const callId = String(p.call_id ?? "");
      return [base({ event_type: "tool_call", tool_name: "web_search", summary: String(p.query ?? "").slice(0, 200), source_id: `${callId}:call` })];
    }
    case "context_compacted":
      return [base({ event_type: "compaction", summary: "Context compaction", source_id: `${threadId}:compact:${at}` })];
    case "task_complete":
      return [base({ event_type: "stop", summary: "Turn complete", source_id: String(p.turn_id ?? `${threadId}:stop:${at}`) })];
    default:
      break;
  }

  // response_item stream
  if (t === "custom_tool_call" && p.name === "exec") {
    const callId = String(p.call_id ?? "");
    return [base({ event_type: "tool_call", tool_name: "exec", summary: "exec", content: String(p.input ?? "").slice(0, 2000), source_id: `${callId}:call` })];
  }
  if (t === "custom_tool_call_output") {
    const callId = String(p.call_id ?? "");
    const status = String(p.status ?? "");
    return [base({ event_type: "tool_result", tool_name: "exec", summary: status === "failed" ? "error" : "ok", content: String(p.output ?? "").slice(0, 2000), source_id: `${callId}:result` })];
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/codex-rollout.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — Expected: no errors.

```bash
git add src/lib/providers/codex-rollout.ts src/lib/__tests__/codex-rollout.test.ts
git commit -m "feat(codex): pure rollout mapper for sessions, events, tokens"
```

---

## Task 3: Idempotent ingest of a single rollout file

**Files:**
- Create: `src/lib/providers/codex-ingest.ts`
- Test: `src/lib/__tests__/codex-ingest.test.ts`

**Interfaces:**
- Consumes: Task 1 db helpers — `getDb`, `createSession`, `createAgent`, `getAgent`, `insertCodexEvent`, `upsertTokenUsage`, `getCodexCursor`, `upsertCodexCursor`; Task 2 mapper functions (`parseRolloutLines`, `readSessionInfo`, `readTokenTotals`, `mapEventRecord`).
- Produces:

```ts
export interface IngestResult { inserted: number; newByteOffset: number; threadId: string | null }
export function ingestRolloutFile(filePath: string, onEvent?: (e: AgentEvent) => void): IngestResult;
```

- Behavior: reads `filePath` from the stored cursor's `byte_offset` (0 if none), consumes only **complete** lines (up to the last `\n`), maps them, writes session/agent (first sight) + events (dedup) + token totals (upsert), advances and persists the cursor. Re-running on an unchanged file inserts 0. `onEvent` is called for each newly inserted event (the watcher wires it to `broadcastEvent`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/codex-ingest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dataDir: string;
let db: typeof import("@/lib/db");
let ingest: typeof import("@/lib/providers/codex-ingest");

const T = "2026-07-14T06:00:00.000Z";
const line = (payload: object, type = "event_msg", timestamp = T) => JSON.stringify({ timestamp, type, payload });

function rolloutText(): string {
  return [
    line({ session_id: "root-1", id: "root-1", cwd: "/Users/me/proj", originator: "codex_work_desktop" }, "session_meta"),
    line({ model: "gpt-5.6-sol", cwd: "/Users/me/proj" }, "turn_context"),
    line({ type: "custom_tool_call", call_id: "e1", name: "exec", input: "ls" }, "response_item"),
    line({ type: "custom_tool_call_output", call_id: "e1", status: "completed", output: "ok" }, "response_item"),
    line({ type: "patch_apply_end", call_id: "p1", success: true, changes: { "/Users/me/proj/a.js": { type: "add" } } }),
    line({ type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } } }),
  ].join("\n") + "\n";
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "llm-ing-"));
  process.env.LLM_DATA_DIR = dataDir;
  db = await import("@/lib/db");
  db.closeDb();
  ingest = await import("@/lib/providers/codex-ingest");
});
afterEach(() => { db.closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe("ingestRolloutFile", () => {
  it("creates an openai session, agent, events, and token usage", () => {
    const fp = join(dataDir, "rollout-a.jsonl");
    writeFileSync(fp, rolloutText());
    const res = ingest.ingestRolloutFile(fp);
    expect(res.threadId).toBe("root-1");
    expect(res.inserted).toBe(4); // exec call + exec result + patch call + patch result

    const sess = db.getDb().prepare("SELECT * FROM sessions WHERE id = 'codex:root-1'").get() as { provider: string; project: string };
    expect(sess.provider).toBe("openai");
    expect(sess.project).toBe("proj");
    const tok = db.getDb().prepare("SELECT * FROM token_usage WHERE session_id = 'codex:root-1'").get() as { model: string; input_tokens: number; cost: number };
    expect(tok.model).toBe("gpt-5.6-sol");
    expect(tok.input_tokens).toBe(100);
    expect(tok.cost).toBe(0);
    const files = db.getDb().prepare("SELECT files_affected FROM agent_events WHERE tool_name='apply_patch' AND event_type='tool_call'").get() as { files_affected: string };
    expect(JSON.parse(files.files_affected)).toEqual(["/Users/me/proj/a.js"]);
  });

  it("is idempotent — re-ingesting an unchanged file inserts nothing", () => {
    const fp = join(dataDir, "rollout-b.jsonl");
    writeFileSync(fp, rolloutText());
    ingest.ingestRolloutFile(fp);
    const res2 = ingest.ingestRolloutFile(fp);
    expect(res2.inserted).toBe(0);
    const n = db.getDb().prepare("SELECT COUNT(*) as n FROM agent_events").get() as { n: number };
    expect(n.n).toBe(4);
  });

  it("tails appended lines from the cursor and fires onEvent", () => {
    const fp = join(dataDir, "rollout-c.jsonl");
    writeFileSync(fp, rolloutText());
    ingest.ingestRolloutFile(fp);
    appendFileSync(fp, line({ type: "web_search_end", call_id: "w1", query: "hello" }) + "\n");
    const seen: string[] = [];
    const res = ingest.ingestRolloutFile(fp, (e) => seen.push(e.tool_name ?? ""));
    expect(res.inserted).toBe(1);
    expect(seen).toContain("web_search");
  });

  it("ignores a partial trailing line until its newline arrives", () => {
    const fp = join(dataDir, "rollout-d.jsonl");
    writeFileSync(fp, rolloutText());
    ingest.ingestRolloutFile(fp);
    appendFileSync(fp, line({ type: "web_search_end", call_id: "w2", query: "partial" })); // no newline
    expect(ingest.ingestRolloutFile(fp).inserted).toBe(0);
    appendFileSync(fp, "\n");
    expect(ingest.ingestRolloutFile(fp).inserted).toBe(1);
  });

  it("records a subagent thread as its own openai session tagged with the parent thread", () => {
    const fp = join(dataDir, "rollout-sub.jsonl");
    writeFileSync(fp, [
      line({
        session_id: "sub-9", id: "sub-9", parent_thread_id: "root-1", cwd: "/Users/me/proj",
        originator: "codex_work_desktop", thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: "root-1", agent_nickname: "Hilbert" } } },
      }, "session_meta"),
      line({ type: "web_search_end", call_id: "sw", query: "x" }),
    ].join("\n") + "\n");

    ingest.ingestRolloutFile(fp);
    const agent = db.getDb().prepare("SELECT session_id, subagent_type, parent_agent_id, metadata FROM agents WHERE id='codex:sub-9'").get() as { session_id: string; subagent_type: string; parent_agent_id: string | null; metadata: string };
    expect(agent.session_id).toBe("codex:sub-9");
    expect(agent.subagent_type).toBe("codex");
    expect(agent.parent_agent_id).toBeNull(); // no cross-file FK in v1
    expect(JSON.parse(agent.metadata).parent_thread_id).toBe("root-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/codex-ingest.test.ts`
Expected: FAIL — module `@/lib/providers/codex-ingest` not found.

- [ ] **Step 3: Write the ingest layer**

Create `src/lib/providers/codex-ingest.ts`:

```ts
import { openSync, readSync, closeSync, fstatSync } from "fs";
import type { AgentEvent } from "@/types";
import {
  getDb, createSession, createAgent, getAgent, insertCodexEvent, upsertTokenUsage,
  getCodexCursor, upsertCodexCursor,
} from "@/lib/db";
import {
  parseRolloutLines, readSessionInfo, readTokenTotals, mapEventRecord,
} from "@/lib/providers/codex-rollout";

export interface IngestResult { inserted: number; newByteOffset: number; threadId: string | null }

// Read only the appended, complete-line prefix past `fromByte` (no whole-file read).
function readComplete(filePath: string, fromByte: number): { text: string; consumedBytes: number } {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= fromByte) return { text: "", consumedBytes: fromByte };
    const len = size - fromByte;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, fromByte);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { text: "", consumedBytes: fromByte }; // no complete line yet — wait for it
    return { text: buf.subarray(0, lastNl + 1).toString("utf8"), consumedBytes: fromByte + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

// v1 model: each rollout thread is its own session + main agent (id `codex:<thread>`).
// Subagent linkage is recorded in metadata (`parent_thread_id`) but NOT via
// agents.parent_agent_id — that FK plus arbitrary file order would risk violations.
// Grouping/true nesting is deferred to Plan 2.
export function ingestRolloutFile(filePath: string, onEvent?: (e: AgentEvent) => void): IngestResult {
  const cursor = getCodexCursor(filePath);
  const fromByte = cursor?.byte_offset ?? 0;
  const { text, consumedBytes } = readComplete(filePath, fromByte);
  if (!text) return { inserted: 0, newByteOffset: fromByte, threadId: cursor?.thread_id ?? null };

  const records = parseRolloutLines(text);

  let sessionDbId = cursor?.session_id ?? null;
  let agentDbId = cursor?.agent_id ?? null;
  let threadId = cursor?.thread_id ?? null;

  // First sight of this file: create its session + main agent from session_meta.
  const info = readSessionInfo(records);
  if (info && !agentDbId) {
    threadId = info.thread_id;
    sessionDbId = `codex:${info.thread_id}`;
    agentDbId = `codex:${info.thread_id}`;
    const meta = info.is_subagent
      ? JSON.stringify({ parent_thread_id: info.root_id, subagent: true })
      : null;
    createSession({
      id: sessionDbId, status: "active", project: info.project, cwd: info.cwd,
      entrypoint: info.entrypoint, started_at: info.started_at, ended_at: null, metadata: meta,
    }, "openai"); // INSERT OR IGNORE — safe to repeat
    if (!getAgent(agentDbId)) {
      createAgent({
        id: agentDbId, session_id: sessionDbId, parent_agent_id: null,
        type: "main", subagent_type: info.is_subagent ? "codex" : null,
        description: info.description, status: "working", current_tool: null,
        started_at: info.started_at, ended_at: null, metadata: meta,
      }, "openai");
    }
  }

  // A tail chunk before we ever saw session_meta: keep the cursor, wait for the header.
  if (!agentDbId || !sessionDbId) {
    upsertCodexCursor({
      file_path: filePath, byte_offset: consumedBytes, line_offset: (cursor?.line_offset ?? 0) + records.length,
      thread_id: threadId, session_id: sessionDbId, agent_id: agentDbId, status: "active", last_seen_at: Date.now(),
    });
    return { inserted: 0, newByteOffset: consumedBytes, threadId };
  }

  let inserted = 0;
  for (const rawRecord of records) {
    for (const ev of mapEventRecord(rawRecord, threadId ?? "")) {
      const created = insertCodexEvent({
        agent_id: agentDbId, session_id: sessionDbId, event_type: ev.event_type,
        tool_name: ev.tool_name, summary: ev.summary, content: ev.content,
        files_affected: ev.files_affected.length ? JSON.stringify(ev.files_affected) : null,
        timestamp: ev.timestamp,
      }, ev.source_id);
      if (created) { inserted++; onEvent?.(created); }
    }
  }

  const tok = readTokenTotals(records);
  if (tok) {
    upsertTokenUsage({
      session_id: sessionDbId, model: tok.model,
      input_tokens: tok.input_tokens, output_tokens: tok.output_tokens,
      cache_read_tokens: tok.cache_read_tokens, cache_write_tokens: tok.cache_write_tokens,
      cost: 0, updated_at: Date.now(),
    }, "openai");
  }

  // Touch the session so listings/rollups see recent activity, even on pure-tail ticks.
  getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionDbId);

  upsertCodexCursor({
    file_path: filePath, byte_offset: consumedBytes, line_offset: (cursor?.line_offset ?? 0) + records.length,
    thread_id: threadId, session_id: sessionDbId, agent_id: agentDbId, status: "active", last_seen_at: Date.now(),
  });

  return { inserted, newByteOffset: consumedBytes, threadId };
}
```

Note: `readTokenTotals` recomputes from only the current chunk. On incremental ticks a chunk may contain no `token_count`; then no upsert runs and the previous total is retained (correct). When a chunk does contain a `token_count`, its cumulative total overwrites — correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/codex-ingest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — Expected: no errors.

```bash
git add src/lib/providers/codex-ingest.ts src/lib/__tests__/codex-ingest.test.ts
git commit -m "feat(codex): idempotent rollout-file ingest with tailing cursor"
```

---

## Task 4: Watcher (backfill + poll) and server-boot registration

**Files:**
- Create: `src/lib/providers/codex-watcher.ts`
- Create: `src/instrumentation.ts`
- Test: `src/lib/__tests__/codex-watcher.test.ts`

**Interfaces:**
- Consumes: `ingestRolloutFile` (Task 3); `broadcastEvent` from `@/lib/ws`.
- Produces:

```ts
export function codexHome(): string | null;                       // CODEX_HOME or ~/.codex, null if absent
export function discoverRolloutFiles(sessionsDir: string, sinceMs: number): string[];  // sorted, date >= since
export function pollOnce(sessionsDir: string): number;            // ingests changed files, returns events inserted
export function startCodexWatcher(opts?: { intervalMs?: number; backfillDays?: number }): () => void; // returns stop()
```

- `discoverRolloutFiles` parses the `rollout-YYYY-MM-DD` prefix from each filename and keeps files whose date is within the window (plus any file modified since `sinceMs`, so an old-named but still-appending session isn't missed).
- `startCodexWatcher` is a no-op returning a no-op `stop()` when `codexHome()` is null.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/codex-watcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dataDir: string;
let sessionsDir: string;
let db: typeof import("@/lib/db");
let watcher: typeof import("@/lib/providers/codex-watcher");

const T = "2026-07-14T06:00:00.000Z";
const line = (payload: object, type = "event_msg") => JSON.stringify({ timestamp: T, type, payload });
function rollout(threadId: string): string {
  return [
    line({ session_id: threadId, id: threadId, cwd: "/Users/me/proj", originator: "codex_work_desktop" }, "session_meta"),
    line({ type: "web_search_end", call_id: `${threadId}-w`, query: "hi" }),
  ].join("\n") + "\n";
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "llm-w-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "llm-sess-"));
  process.env.LLM_DATA_DIR = dataDir;
  db = await import("@/lib/db");
  db.closeDb();
  watcher = await import("@/lib/providers/codex-watcher");
});
afterEach(() => {
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("discoverRolloutFiles", () => {
  it("keeps files within the date window and skips older ones", () => {
    const d = join(sessionsDir, "2026", "07", "14");
    mkdirSync(d, { recursive: true });
    const recent = join(d, "rollout-2026-07-14T06-00-00-aaa.jsonl");
    writeFileSync(recent, rollout("aaa"));
    const oldD = join(sessionsDir, "2025", "12", "15");
    mkdirSync(oldD, { recursive: true });
    const old = join(oldD, "rollout-2025-12-15T10-00-00-bbb.jsonl");
    writeFileSync(old, rollout("bbb"));

    const since = Date.parse("2026-07-01T00:00:00.000Z");
    const found = watcher.discoverRolloutFiles(sessionsDir, since);
    expect(found).toContain(recent);
    expect(found).not.toContain(old);
  });
});

describe("pollOnce", () => {
  it("ingests new rollout files and returns inserted event count", () => {
    const d = join(sessionsDir, "2026", "07", "14");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "rollout-2026-07-14T06-00-00-ccc.jsonl"), rollout("ccc"));

    const inserted = watcher.pollOnce(sessionsDir);
    expect(inserted).toBe(1);
    const sess = db.getDb().prepare("SELECT provider FROM sessions WHERE id='codex:ccc'").get() as { provider: string };
    expect(sess.provider).toBe("openai");

    // second poll, no changes
    expect(watcher.pollOnce(sessionsDir)).toBe(0);
  });
});

describe("startCodexWatcher", () => {
  it("returns a no-op stop when there is no codex home", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(sessionsDir, "does-not-exist");
    const stop = watcher.startCodexWatcher({ intervalMs: 999999 });
    expect(typeof stop).toBe("function");
    stop();
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/codex-watcher.test.ts`
Expected: FAIL — module `@/lib/providers/codex-watcher` not found.

- [ ] **Step 3: Write the watcher**

Create `src/lib/providers/codex-watcher.ts`:

```ts
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ingestRolloutFile } from "@/lib/providers/codex-ingest";
import { broadcastEvent } from "@/lib/ws";

const DAY = 86400000;

export function codexHome(): string | null {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return existsSync(join(home, "sessions")) ? home : null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: import("fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function dateFromName(name: string): number | null {
  const m = name.match(/rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
}

export function discoverRolloutFiles(sessionsDir: string, sinceMs: number): string[] {
  const files = walk(sessionsDir).filter((f) => {
    const named = dateFromName(f.split("/").pop() || "");
    if (named != null && named >= sinceMs - DAY) return true; // within window by name
    try { return statSync(f).mtimeMs >= sinceMs; } catch { return false; } // or recently touched
  });
  return files.sort();
}

export function pollOnce(sessionsDir: string, sinceMs = 0): number {
  let total = 0;
  for (const file of discoverRolloutFiles(sessionsDir, sinceMs)) {
    try {
      const res = ingestRolloutFile(file, (e) => broadcastEvent({ type: "event_created", data: e }));
      total += res.inserted;
    } catch (err) {
      console.error(`[codex-watcher] ingest failed for ${file}:`, err);
    }
  }
  return total;
}

export function startCodexWatcher(opts?: { intervalMs?: number; backfillDays?: number }): () => void {
  const home = codexHome();
  if (!home) {
    console.log("[codex-watcher] no ~/.codex/sessions found — Codex tracking disabled");
    return () => {};
  }
  const sessionsDir = join(home, "sessions");
  const intervalMs = opts?.intervalMs ?? 4000;
  const backfillDays = opts?.backfillDays ?? 90;
  const since = Date.now() - backfillDays * DAY;

  try {
    const n = pollOnce(sessionsDir, since);
    console.log(`[codex-watcher] backfill complete — ${n} events from the last ${backfillDays}d`);
  } catch (err) {
    console.error("[codex-watcher] backfill error:", err);
  }

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try { pollOnce(sessionsDir, since); }
    catch (err) { console.error("[codex-watcher] poll error:", err); }
    finally { running = false; }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/codex-watcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the watcher on server boot**

Create `src/instrumentation.ts`:

```ts
// Next.js instrumentation hook — runs once when the server process starts
// (Node.js runtime only), in both the Electron-wrapped and Docker deployments.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startCodexWatcher } = await import("@/lib/providers/codex-watcher");
  startCodexWatcher();
}
```

- [ ] **Step 6: Verify the full suite and typecheck**

Run: `npx vitest run` — Expected: all test files PASS.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/providers/codex-watcher.ts src/instrumentation.ts src/lib/__tests__/codex-watcher.test.ts
git commit -m "feat(codex): polling watcher + instrumentation boot hook"
```

---

## Task 5: End-to-end verification against real Codex logs

**Files:** none (verification only).

- [ ] **Step 1: Build the app**

Run: `npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 2: Start the dev server and let the watcher backfill**

Start the dev server (`preview_start` with the project's launch config, or `npm run dev`). Watch the server logs for `[codex-watcher] backfill complete — N events from the last 90d` with N > 0.

- [ ] **Step 3: Confirm Codex data landed with `provider='openai'`**

Run:
```bash
sqlite3 .data/agent-monitor.db "SELECT provider, COUNT(*) FROM sessions GROUP BY provider;"
sqlite3 .data/agent-monitor.db "SELECT tool_name, COUNT(*) FROM agent_events WHERE provider='openai' GROUP BY tool_name ORDER BY 2 DESC LIMIT 10;"
sqlite3 .data/agent-monitor.db "SELECT model, input_tokens, output_tokens, cost FROM token_usage WHERE provider='openai' LIMIT 5;"
```
Expected: an `openai` sessions row; Codex tool names (`exec`, `apply_patch`, `mcp__*`, `web_search`); token rows with `cost = 0`.

- [ ] **Step 4: Confirm it shows in the UI**

Open the Analytics page in the browser preview. The Tools and Files panels should now include Codex tool/file activity; the Models panel should show the Codex model with token counts. (Provider is not yet filterable — that's Plan 2 — so Codex appears mixed in, labeled by its `codex-*` entrypoint.)

- [ ] **Step 5: Confirm idempotency across restarts**

Restart the server. Confirm the backfill log reports ~0 new events on the second boot (cursors persisted) and the `agent_events` count for `provider='openai'` is unchanged.

```bash
sqlite3 .data/agent-monitor.db "SELECT COUNT(*) FROM agent_events WHERE provider='openai';"
```

---

## Plan 2 preview (separate plan, after this one)

Provider **segmentation** — not built here:
1. Optional `provider?: ProviderId` argument on the 7 analytics functions in `db.ts` (adds `AND provider = ?`).
2. `?provider=` passthrough in the 6 `/api/analytics/*` routes and the monitor routes.
3. `ProviderFilter` component (All / Claude / OpenAI, mirroring `TimeRangePicker`), threaded through `use-analytics.ts` and the analytics page.
4. Provider badges on session rows + `AgentCard`; provider filter in the Monitor via `use-agent-monitor.ts`.

## Self-review notes (from writing this plan)

- **Spec coverage:** ingestion, mapper, schema, backfill (90d), live tailing, dedup, token-without-cost, subagent linkage, error handling, and boot registration all map to Tasks 1–4; Plan-2 items (provider filtering + UI) are explicitly deferred. The spec's session_end-by-staleness is intentionally deferred to Plan 2's monitor work — Task 3 leaves Codex `ended_at` NULL, and existing analytics already clamp NULL `ended_at` to the last event, so durations remain correct in the interim.
- **Naming reconciliation:** DB provider value is `"claude"` (matching `ProviderId`), superseding the spec's `"anthropic"`. The spec doc is updated to match.
- **Subagent deviation (flag to user):** The spec nests subagent threads under the parent's session via `agents.parent_agent_id`. That FK (`agents.parent_agent_id REFERENCES agents(id)`, `foreign_keys = ON`) plus arbitrary rollout-file processing order risks constraint violations when a child file is read before its parent. v1 therefore uses a **flat per-thread model**: every Codex thread is its own `codex:<thread_id>` session + main agent, with `parent_thread_id` recorded in `metadata`. Tool/event/file/token analytics (the primary goal) are unaffected; the only cost is extra rows in the Sessions list. True nesting is deferred to Plan 2 (where a batch pass can resolve the full graph up-front). Duration handling is likewise interim: Codex `ended_at` stays NULL and analytics clamp to the last event.
- **Type consistency pass:** `insertCodexEvent` returns `AgentEvent | null` (Task 1) and Task 3 broadcasts that exact row; `createSession`/`createAgent`/`upsertTokenUsage` use `Omit<…, "provider">` (+ computed field) signatures consumed verbatim by Task 3; mapper event types (`tool_call`/`tool_result`/`compaction`/`stop`) are all members of `AgentEventType`.
