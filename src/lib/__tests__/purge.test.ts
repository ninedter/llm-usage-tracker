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
