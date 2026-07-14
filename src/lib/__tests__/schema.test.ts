import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CodexIngestRow } from "@/types";

let tmpDir: string;

beforeAll(() => {
  // getDb() reads LLM_DATA_DIR lazily on its first call, so pointing it at
  // an isolated temp dir here (before any helper below runs) keeps this
  // suite from touching the real .data/agent-monitor.db.
  tmpDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-schema-"));
  process.env.LLM_DATA_DIR = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import {
  getDb,
  createSession,
  createEvent,
  upsertTokenUsage,
  getCodexIngest,
  upsertCodexIngest,
} from "@/lib/db";

function tableInfo(table: "sessions" | "agent_events" | "token_usage") {
  return getDb().prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
}

describe("schema: provider column, source_id dedup, codex_ingest", () => {
  it("adds a NOT NULL provider column defaulting to 'anthropic' on sessions, agent_events, token_usage", () => {
    for (const table of ["sessions", "agent_events", "token_usage"] as const) {
      const col = tableInfo(table).find((c) => c.name === "provider");
      expect(col, `${table}.provider should exist`).toBeDefined();
      expect(col!.notnull, `${table}.provider should be NOT NULL`).toBe(1);
      expect(col!.dflt_value, `${table}.provider should default to 'anthropic'`).toBe("'anthropic'");
    }
  });

  it("createSession/createEvent/upsertTokenUsage default provider to 'anthropic' for existing callers (no new args passed)", () => {
    const now = Date.now();
    const d = getDb();

    createSession({ id: "sess-legacy", status: "active", project: "p", cwd: "/tmp", entrypoint: "cli", started_at: now, ended_at: null, metadata: null });
    const sessionRow = d.prepare("SELECT provider FROM sessions WHERE id = ?").get("sess-legacy") as { provider: string };
    expect(sessionRow.provider).toBe("anthropic");

    const event = createEvent({ agent_id: "agent-legacy", session_id: "sess-legacy", event_type: "tool_call", tool_name: "Bash", summary: null, content: null, files_affected: null, timestamp: now });
    expect(event.provider).toBe("anthropic");
    expect(event.source_id).toBeNull();
    const eventRow = d.prepare("SELECT provider, source_id FROM agent_events WHERE id = ?").get(event.id) as { provider: string; source_id: string | null };
    expect(eventRow.provider).toBe("anthropic");
    expect(eventRow.source_id).toBeNull();

    upsertTokenUsage({ session_id: "sess-legacy", model: "claude-opus", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0.01, updated_at: now });
    const tokenRow = d.prepare("SELECT provider FROM token_usage WHERE session_id = ? AND model = ?").get("sess-legacy", "claude-opus") as { provider: string };
    expect(tokenRow.provider).toBe("anthropic");
  });

  it("accepts an explicit 'openai' provider via the new trailing argument", () => {
    const now = Date.now();
    const d = getDb();

    createSession({ id: "codex:sess-1", status: "active", project: "p", cwd: "/tmp", entrypoint: "codex-cli", started_at: now, ended_at: null, metadata: null }, "openai");
    const sessionRow = d.prepare("SELECT provider FROM sessions WHERE id = ?").get("codex:sess-1") as { provider: string };
    expect(sessionRow.provider).toBe("openai");

    upsertTokenUsage({ session_id: "codex:sess-1", model: "gpt-5-codex", input_tokens: 100, output_tokens: 40, cache_read_tokens: 20, cache_write_tokens: 0, cost: 0, updated_at: now }, "openai");
    const tokenRow = d.prepare("SELECT provider FROM token_usage WHERE session_id = ? AND model = ?").get("codex:sess-1", "gpt-5-codex") as { provider: string };
    expect(tokenRow.provider).toBe("openai");
  });

  it("agent_events.source_id has a partial unique index: rejects a duplicate non-null value, allows repeated NULLs", () => {
    const d = getDb();
    const now = Date.now();
    const insertRaw = d.prepare(`
      INSERT INTO agent_events (agent_id, session_id, provider, source_id, event_type, tool_name, summary, content, files_affected, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertRaw.run("agent-raw", "sess-raw", "openai", "raw-dup-1", "tool_call", "exec", null, null, null, now, now);
    expect(() => insertRaw.run("agent-raw", "sess-raw", "openai", "raw-dup-1", "tool_call", "exec", null, null, null, now, now))
      .toThrow(/UNIQUE constraint failed/);

    // Multiple NULL source_id rows (the untouched Claude path) must remain allowed.
    expect(() => {
      insertRaw.run("agent-raw", "sess-raw", "anthropic", null, "tool_call", "Bash", null, null, null, now, now);
      insertRaw.run("agent-raw", "sess-raw", "anthropic", null, "tool_call", "Bash", null, null, null, now, now);
    }).not.toThrow();

    const nullCount = (d.prepare("SELECT COUNT(*) as n FROM agent_events WHERE agent_id = 'agent-raw' AND source_id IS NULL").get() as { n: number }).n;
    expect(nullCount).toBe(2);
  });

  it("createEvent uses INSERT OR IGNORE when sourceId is passed, so re-ingesting the same Codex record never duplicates", () => {
    const d = getDb();
    const now = Date.now();
    createSession({ id: "codex:sess-2", status: "active", project: "p", cwd: "/tmp", entrypoint: "codex-cli", started_at: now, ended_at: null, metadata: null }, "openai");

    const first = createEvent(
      { agent_id: "codex:agent-2", session_id: "codex:sess-2", event_type: "tool_call", tool_name: "exec", summary: null, content: null, files_affected: null, timestamp: now },
      "openai",
      "codex-call-1"
    );
    createEvent(
      { agent_id: "codex:agent-2", session_id: "codex:sess-2", event_type: "tool_call", tool_name: "exec", summary: null, content: null, files_affected: null, timestamp: now },
      "openai",
      "codex-call-1"
    );

    const rows = d.prepare("SELECT id, provider FROM agent_events WHERE source_id = ?").all("codex-call-1") as { id: number; provider: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openai");
    expect(first.source_id).toBe("codex-call-1");
  });

  it("upsertCodexIngest/getCodexIngest round-trips a per-file tail cursor and upserts in place", () => {
    expect(getCodexIngest("/does/not/exist.jsonl")).toBeNull();

    const row: CodexIngestRow = {
      file_path: "/codex/sessions/2026/07/14/rollout-1.jsonl",
      byte_offset: 128,
      thread_id: "thread-abc",
      last_seen_at: Date.now(),
      status: "active",
    };
    upsertCodexIngest(row);
    expect(getCodexIngest(row.file_path)).toEqual(row);

    // Re-upsert with a new offset/status updates the existing row in place.
    const updated: CodexIngestRow = { ...row, byte_offset: 4096, status: "done", last_seen_at: row.last_seen_at + 1000 };
    upsertCodexIngest(updated);
    expect(getCodexIngest(row.file_path)).toEqual(updated);

    const count = (getDb().prepare("SELECT COUNT(*) as n FROM codex_ingest WHERE file_path = ?").get(row.file_path) as { n: number }).n;
    expect(count).toBe(1);
  });

  it("re-running getDb()'s setup against an already-migrated file does not throw (simulates an app restart)", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/db");
    expect(() => fresh.getDb()).not.toThrow();
    fresh.getDb().close();
  });
});
