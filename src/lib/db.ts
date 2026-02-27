import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { AgentRecord, AgentEvent, AgentSession, SessionRecord, TokenUsage, MonitorStats } from "@/types";

let db: Database.Database | null = null;

function getDbPath(): string {
  const dataDir = process.env.LLM_DATA_DIR || join(process.cwd(), ".data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "agent-monitor.db");
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'active',
      project         TEXT NOT NULL DEFAULT '',
      cwd             TEXT NOT NULL DEFAULT '',
      entrypoint      TEXT NOT NULL DEFAULT '',
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      updated_at      INTEGER NOT NULL,
      metadata        TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      parent_agent_id TEXT,
      type            TEXT NOT NULL DEFAULT 'main',
      subagent_type   TEXT,
      description     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'idle',
      current_tool    TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      metadata        TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL DEFAULT '',
      event_type      TEXT NOT NULL,
      tool_name       TEXT,
      summary         TEXT,
      content         TEXT,
      files_affected  TEXT,
      timestamp       INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      session_id      TEXT NOT NULL,
      model           TEXT NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost            REAL NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (session_id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_events_agent_id ON agent_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON agent_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON agent_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON agent_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);

  // Forward-compatible migrations: add columns if they don't exist
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const colNames = new Set(agentCols.map(c => c.name));
  if (!colNames.has("subagent_type")) db.exec("ALTER TABLE agents ADD COLUMN subagent_type TEXT");
  if (!colNames.has("current_tool")) db.exec("ALTER TABLE agents ADD COLUMN current_tool TEXT");

  const eventCols = db.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[];
  const eventColNames = new Set(eventCols.map(c => c.name));
  if (!eventColNames.has("session_id")) db.exec("ALTER TABLE agent_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");

  return db;
}

// --- Session CRUD ---

export function createSession(session: Omit<SessionRecord, "updated_at">): SessionRecord {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO sessions (id, status, project, cwd, entrypoint, started_at, ended_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, session.status, session.project, session.cwd, session.entrypoint, session.started_at, session.ended_at, now, session.metadata);
  return { ...session, updated_at: now };
}

export function getSession(id: string): SessionRecord | null {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | null;
}

export function updateSession(id: string, updates: Partial<Pick<SessionRecord, "status" | "ended_at" | "metadata">>): SessionRecord | null {
  const d = getDb();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [Date.now()];

  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.ended_at !== undefined) { fields.push("ended_at = ?"); values.push(updates.ended_at); }
  if (updates.metadata !== undefined) { fields.push("metadata = ?"); values.push(updates.metadata); }

  values.push(id);
  d.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function ensureSession(sessionId: string, project?: string, cwd?: string, entrypoint?: string): SessionRecord {
  const existing = getSession(sessionId);
  if (existing) {
    // Reactivate if needed
    if (existing.status !== "active") {
      return updateSession(sessionId, { status: "active" }) || existing;
    }
    // Touch updated_at
    getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    return { ...existing, updated_at: Date.now() };
  }

  return createSession({
    id: sessionId,
    status: "active",
    project: project || "",
    cwd: cwd || "",
    entrypoint: entrypoint || "",
    started_at: Date.now(),
    ended_at: null,
    metadata: null,
  });
}

// --- Agent CRUD ---

export function createAgent(agent: Omit<AgentRecord, "created_at">): AgentRecord {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO agents (id, session_id, parent_agent_id, type, subagent_type, description, status, current_tool, started_at, ended_at, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id, agent.session_id, agent.parent_agent_id, agent.type, agent.subagent_type,
    agent.description, agent.status, agent.current_tool, agent.started_at, agent.ended_at, agent.metadata, now
  );
  return { ...agent, created_at: now };
}

export function updateAgent(id: string, updates: Partial<Pick<AgentRecord, "status" | "ended_at" | "description" | "metadata" | "current_tool" | "subagent_type">>): AgentRecord | null {
  const d = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.ended_at !== undefined) { fields.push("ended_at = ?"); values.push(updates.ended_at); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.metadata !== undefined) { fields.push("metadata = ?"); values.push(updates.metadata); }
  if (updates.current_tool !== undefined) { fields.push("current_tool = ?"); values.push(updates.current_tool); }
  if (updates.subagent_type !== undefined) { fields.push("subagent_type = ?"); values.push(updates.subagent_type); }

  if (fields.length === 0) return getAgent(id);

  values.push(id);
  d.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgent(id);
}

export function getAgent(id: string): AgentRecord | null {
  return getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRecord | null;
}

export function listAgents(filters?: {
  session_id?: string;
  status?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): AgentRecord[] {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters?.session_id) { clauses.push("session_id = ?"); values.push(filters.session_id); }
  if (filters?.status) { clauses.push("status = ?"); values.push(filters.status); }
  if (filters?.type) { clauses.push("type = ?"); values.push(filters.type); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  return getDb().prepare(
    `SELECT * FROM agents ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset) as AgentRecord[];
}

export function getAgentChildren(parentId: string): AgentRecord[] {
  return getDb().prepare(
    "SELECT * FROM agents WHERE parent_agent_id = ? ORDER BY started_at ASC"
  ).all(parentId) as AgentRecord[];
}

// Find main agent for a session
export function getMainAgent(sessionId: string): AgentRecord | null {
  return getDb().prepare(
    "SELECT * FROM agents WHERE session_id = ? AND type = 'main' LIMIT 1"
  ).get(sessionId) as AgentRecord | null;
}

// Find working subagents for matching on SubagentStop
export function getWorkingSubagents(sessionId: string): AgentRecord[] {
  return getDb().prepare(
    "SELECT * FROM agents WHERE session_id = ? AND type = 'subagent' AND status = 'working' ORDER BY started_at ASC"
  ).all(sessionId) as AgentRecord[];
}

// --- Auto-register agent if not exists ---

export function ensureAgent(agentId: string, sessionId?: string, project?: string, entrypoint?: string): AgentRecord {
  const existing = getAgent(agentId);
  if (existing) return existing;

  const projectName = project || "unknown-project";
  const source = entrypoint === "claude-desktop" ? "Desktop" : entrypoint === "cli" ? "Terminal" : entrypoint || "Agent";
  const description = `${projectName} (${source})`;

  // Also ensure session exists
  if (sessionId) {
    ensureSession(sessionId, projectName, undefined, entrypoint);
  }

  return createAgent({
    id: agentId,
    session_id: sessionId || agentId,
    parent_agent_id: null,
    type: "main",
    subagent_type: null,
    description,
    status: "working",
    current_tool: null,
    started_at: Date.now(),
    ended_at: null,
    metadata: project ? JSON.stringify({ project, entrypoint }) : null,
  });
}

// --- Event CRUD ---

export function createEvent(event: Omit<AgentEvent, "id" | "created_at">): AgentEvent {
  const now = Date.now();
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO agent_events (agent_id, session_id, event_type, tool_name, summary, content, files_affected, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.agent_id, event.session_id, event.event_type,
    event.tool_name, event.summary, event.content, event.files_affected,
    event.timestamp, now
  );
  return { ...event, id: Number(result.lastInsertRowid), created_at: now };
}

export function listEvents(agentId: string, filters?: {
  event_type?: string;
  limit?: number;
  offset?: number;
}): AgentEvent[] {
  const clauses: string[] = ["agent_id = ?"];
  const values: unknown[] = [agentId];

  if (filters?.event_type) { clauses.push("event_type = ?"); values.push(filters.event_type); }

  const limit = filters?.limit ?? 500;
  const offset = filters?.offset ?? 0;

  return getDb().prepare(
    `SELECT * FROM agent_events WHERE ${clauses.join(" AND ")} ORDER BY timestamp ASC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset) as AgentEvent[];
}

export function listSessionEvents(sessionId: string, filters?: {
  event_type?: string;
  limit?: number;
  offset?: number;
}): AgentEvent[] {
  const clauses: string[] = ["session_id = ?"];
  const values: unknown[] = [sessionId];

  if (filters?.event_type) { clauses.push("event_type = ?"); values.push(filters.event_type); }

  const limit = filters?.limit ?? 500;
  const offset = filters?.offset ?? 0;

  return getDb().prepare(
    `SELECT * FROM agent_events WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset) as AgentEvent[];
}

export function getRecentEvents(limit = 50): AgentEvent[] {
  return getDb().prepare(
    "SELECT * FROM agent_events ORDER BY timestamp DESC LIMIT ?"
  ).all(limit) as AgentEvent[];
}

export function getLatestEvent(agentId: string): AgentEvent | null {
  return getDb().prepare(
    "SELECT * FROM agent_events WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1"
  ).get(agentId) as AgentEvent | null;
}

// --- Token Usage ---

export function upsertTokenUsage(usage: TokenUsage): void {
  getDb().prepare(`
    INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost = excluded.cost,
      updated_at = excluded.updated_at
  `).run(usage.session_id, usage.model, usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.cost, usage.updated_at);
}

export function getSessionTokenUsage(sessionId: string): TokenUsage[] {
  return getDb().prepare("SELECT * FROM token_usage WHERE session_id = ?").all(sessionId) as TokenUsage[];
}

export function getTotalCost(): number {
  const row = getDb().prepare("SELECT COALESCE(SUM(cost), 0) as total FROM token_usage").get() as { total: number };
  return row.total;
}

// --- Sessions with aggregated data ---

export function listSessions(limit = 50): AgentSession[] {
  return getDb().prepare(`
    SELECT
      s.id as session_id,
      s.status,
      s.project,
      s.entrypoint,
      COUNT(DISTINCT a.id) as agent_count,
      COALESCE(SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END), 0) as working_count,
      COALESCE(SUM(CASE WHEN a.type = 'subagent' THEN 1 ELSE 0 END), 0) as subagent_count,
      (SELECT COUNT(*) FROM agent_events WHERE session_id = s.id) as event_count,
      COALESCE((SELECT SUM(cost) FROM token_usage WHERE session_id = s.id), 0) as total_cost,
      s.started_at as first_started,
      s.updated_at as last_activity
    FROM sessions s
    LEFT JOIN agents a ON a.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit) as AgentSession[];
}

export function getSessionAgents(sessionId: string): AgentRecord[] {
  return getDb().prepare(
    "SELECT * FROM agents WHERE session_id = ? ORDER BY started_at ASC"
  ).all(sessionId) as AgentRecord[];
}

// --- Stats ---

export function getMonitorStats(): MonitorStats {
  const d = getDb();
  const sessions = d.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM sessions").get() as { total: number; active: number };
  const agents = d.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working FROM agents").get() as { total: number; working: number };
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const events = d.prepare("SELECT COUNT(*) as total FROM agent_events").get() as { total: number };
  const eventsToday = d.prepare("SELECT COUNT(*) as total FROM agent_events WHERE timestamp >= ?").get(todayStart.getTime()) as { total: number };
  const cost = getTotalCost();

  return {
    total_sessions: sessions.total,
    active_sessions: sessions.active,
    total_agents: agents.total,
    working_agents: agents.working,
    total_events: events.total,
    events_today: eventsToday.total,
    total_cost: cost,
  };
}

// --- Cleanup ---

export function completeSessionAgents(sessionId: string): void {
  const now = Date.now();
  getDb().prepare("UPDATE agents SET status = 'completed', ended_at = ? WHERE session_id = ? AND status IN ('working', 'idle')").run(now, sessionId);
}

export function deleteOldSessions(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const d = getDb();
  d.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  d.prepare("DELETE FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  d.prepare("DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoff);
  const result = d.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoff);
  return result.changes;
}

// Clear all monitor data
export function clearAllMonitorData(): { sessions: number; agents: number; events: number; token_usage: number } {
  const d = getDb();
  const events = d.prepare("DELETE FROM agent_events").run().changes;
  const agents = d.prepare("DELETE FROM agents").run().changes;
  const tokenUsage = d.prepare("DELETE FROM token_usage").run().changes;
  const sessions = d.prepare("DELETE FROM sessions").run().changes;
  return { sessions, agents, events, token_usage: tokenUsage };
}

// Abandon stale sessions (idle > 5 minutes)
export function abandonStaleSessions(): number {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const d = getDb();
  const result = d.prepare("UPDATE sessions SET status = 'abandoned', ended_at = ? WHERE status = 'active' AND updated_at < ?").run(Date.now(), cutoff);
  // Also complete their agents
  if (result.changes > 0) {
    d.prepare("UPDATE agents SET status = 'completed', ended_at = ? WHERE status IN ('working', 'idle') AND session_id IN (SELECT id FROM sessions WHERE status = 'abandoned')").run(Date.now());
  }
  return result.changes;
}
