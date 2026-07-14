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

describe("previewPurge / deleteBefore", () => {
  it("counts and deletes only rows strictly before the cutoff, keeping the boundary row", () => {
    const cutoff = 1_000_000;
    seedSession("old", cutoff - 1);
    seedAgent("ag-old", "old");
    seedEvent("old", cutoff - 1);
    seedTokenUsage("old"); // old token_usage row → should be deleted
    seedSession("edge", cutoff); // exactly at cutoff → kept
    seedAgent("ag-edge", "edge"); // agent on the boundary session → must be KEPT
    seedEvent("edge", cutoff);
    seedTokenUsage("edge"); // token_usage on the boundary session → must be KEPT
    seedSession("new", cutoff + 1); // newer → kept
    seedEvent("new", cutoff + 1);

    expect(db.previewPurge(cutoff)).toEqual({ sessions: 1, agents: 1, events: 1, token_usage: 1 });

    const deleted = db.deleteBefore(cutoff);
    expect(deleted).toEqual({ sessions: 1, agents: 1, events: 1, token_usage: 1 });

    // preview is now empty and boundary + newer rows survive
    expect(db.previewPurge(cutoff)).toEqual({ sessions: 0, agents: 0, events: 0, token_usage: 0 });
    const d = db.getDb();
    expect((d.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n).toBe(1);
    expect((d.prepare("SELECT COUNT(*) n FROM token_usage").get() as { n: number }).n).toBe(1);
  });
});

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
