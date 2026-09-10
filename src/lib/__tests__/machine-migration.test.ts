import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Builds a database in the pre-multi-machine shape (single-column session PK,
// global unique index on source_id, no machine_id anywhere), then lets getDb()
// migrate it — the upgrade path every existing install will take.
let tmpDir: string;
let db: typeof import("@/lib/db");

function seedLegacyDb(path: string) {
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '', entrypoint TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'anthropic', started_at INTEGER NOT NULL, ended_at INTEGER,
      updated_at INTEGER NOT NULL, metadata TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_agent_id TEXT, type TEXT NOT NULL DEFAULT 'main',
      subagent_type TEXT, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle',
      current_tool TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );
    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'anthropic', source_id TEXT, event_type TEXT NOT NULL, tool_name TEXT,
      summary TEXT, content TEXT, files_affected TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_events_source_id ON agent_events(source_id) WHERE source_id IS NOT NULL;
    CREATE TABLE token_usage (
      session_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'anthropic',
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, model)
    );
    CREATE TABLE daily_usage (
      date TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, session_count INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0, tool_failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, model, project)
    );
  `);

  d.prepare("INSERT INTO sessions (id,status,project,cwd,entrypoint,provider,started_at,ended_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("legacy-session", "completed", "proj", "/tmp", "cli", "anthropic", 1000, 2000, 2000, null);
  d.prepare("INSERT INTO agents (id,session_id,parent_agent_id,type,subagent_type,description,status,current_tool,started_at,ended_at,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy-main", "legacy-session", null, "main", null, "d", "completed", null, 1000, 2000, null, 1000);
  d.prepare("INSERT INTO agents (id,session_id,parent_agent_id,type,subagent_type,description,status,current_tool,started_at,ended_at,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy-sub", "legacy-session", "legacy-main", "subagent", "Explore", "d", "completed", null, 1100, 1900, null, 1100);
  d.prepare("INSERT INTO agent_events (agent_id,session_id,provider,source_id,event_type,tool_name,summary,content,files_affected,timestamp,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy-main", "legacy-session", "anthropic", "codex:1", "tool_call", "Read", null, null, null, 1500, 1500);
  d.prepare("INSERT INTO token_usage (session_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("legacy-session", "claude-opus", "anthropic", 10, 5, 0, 0, 0.25, 2000);
  d.prepare("INSERT INTO daily_usage (date,model,project,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,session_count,tool_calls,tool_failures) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("2026-01-01", "claude-opus", "proj", 10, 5, 0, 0, 0.25, 1, 1, 0);
  d.close();
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "machine-migration-"));
  seedLegacyDb(join(tmpDir, "agent-monitor.db"));
  process.env.LLM_DATA_DIR = tmpDir;
  db = await import("@/lib/db");
});

afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

function pk(table: string): string[] {
  const cols = db.getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
  return cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

describe("machine_id migration of a pre-hub database", () => {
  it("widens the primary keys to include machine_id", () => {
    expect(pk("sessions")).toEqual(["machine_id", "id"]);
    expect(pk("agents")).toEqual(["machine_id", "id"]);
    expect(pk("token_usage")).toEqual(["machine_id", "session_id", "model"]);
    expect(pk("daily_usage")).toEqual(["machine_id", "date", "model", "project"]);
  });

  it("adds a NOT NULL machine_id defaulting to 'local' on every usage table", () => {
    for (const table of ["sessions", "agents", "agent_events", "token_usage", "daily_usage"]) {
      const col = (db.getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[])
        .find(c => c.name === "machine_id");
      expect(col, `${table}.machine_id should exist`).toBeDefined();
      expect(col!.notnull, `${table}.machine_id should be NOT NULL`).toBe(1);
      expect(col!.dflt_value).toBe("'local'");
    }
  });

  it("backfills every existing row to machine 'local' without losing data", () => {
    const d = db.getDb();
    const counts = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
    expect(counts("SELECT COUNT(*) n FROM sessions WHERE machine_id = 'local'")).toBe(1);
    expect(counts("SELECT COUNT(*) n FROM agents WHERE machine_id = 'local'")).toBe(2);
    expect(counts("SELECT COUNT(*) n FROM agent_events WHERE machine_id = 'local'")).toBe(1);
    expect(counts("SELECT COUNT(*) n FROM token_usage WHERE machine_id = 'local'")).toBe(1);
    expect(counts("SELECT COUNT(*) n FROM daily_usage WHERE machine_id = 'local'")).toBe(1);

    const session = d.prepare("SELECT * FROM sessions WHERE id = 'legacy-session'").get() as Record<string, unknown>;
    expect(session).toMatchObject({ status: "completed", project: "proj", provider: "anthropic", started_at: 1000, ended_at: 2000 });
    expect(session.machine_label).toBeNull();

    // The parent/child link survives the rebuild
    const sub = d.prepare("SELECT parent_agent_id, machine_id FROM agents WHERE id = 'legacy-sub'").get() as Record<string, unknown>;
    expect(sub).toEqual({ parent_agent_id: "legacy-main", machine_id: "local" });
  });

  it("replaces the global unique index on source_id with a machine-scoped one", () => {
    const d = db.getDb();
    const indexes = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_events'").all() as { name: string }[])
      .map(i => i.name);
    expect(indexes).toContain("idx_events_machine_source_id");
    expect(indexes).not.toContain("idx_events_source_id");

    // The same key from another machine is now a distinct event...
    d.prepare("INSERT INTO agent_events (agent_id,session_id,machine_id,provider,source_id,event_type,tool_name,summary,content,files_affected,timestamp,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("remote-main", "legacy-session", "laptop", "anthropic", "codex:1", "tool_call", "Read", null, null, null, 1500, 1500);
    expect((d.prepare("SELECT COUNT(*) n FROM agent_events WHERE source_id = 'codex:1'").get() as { n: number }).n).toBe(2);

    // ...while a replay within one machine is still rejected
    expect(() =>
      d.prepare("INSERT INTO agent_events (agent_id,session_id,machine_id,provider,source_id,event_type,tool_name,summary,content,files_affected,timestamp,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("legacy-main", "legacy-session", "local", "anthropic", "codex:1", "tool_call", "Read", null, null, null, 1500, 1500)
    ).toThrow(/UNIQUE/);
  });

  it("is idempotent — a second open of an already-migrated DB changes nothing", () => {
    const before = db.getDb().prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number };
    const reopened = new Database(join(tmpDir, "agent-monitor.db"));
    const after = reopened.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number };
    reopened.close();
    expect(after.n).toBe(before.n);
    expect(pk("sessions")).toEqual(["machine_id", "id"]);
  });
});
