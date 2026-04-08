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
    CREATE INDEX IF NOT EXISTS idx_agents_session_type_status ON agents(session_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

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

export function archiveStaleAgents(): number {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const d = getDb();
  const result = d.prepare(
    "UPDATE agents SET status = 'archived' WHERE status IN ('completed', 'failed', 'cancelled') AND ended_at IS NOT NULL AND ended_at < ?"
  ).run(cutoff);
  return result.changes;
}

export function rollupDailyUsage(dateStr?: string): void {
  const d = getDb();
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const dayStart = new Date(date + "T00:00:00").getTime();
  const dayEnd = dayStart + 86400000;

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

// --- Analytics Queries ---

export function getAnalyticsOverview(from: number, to: number): import("@/types").AnalyticsOverview {
  const d = getDb();
  const periodLength = to - from;
  const prevFrom = from - periodLength;
  const prevTo = from;

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

  const prev = d.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
  `).get(prevFrom, prevTo) as { total_cost: number };

  const costChangePct = prev.total_cost > 0
    ? ((current.total_cost - prev.total_cost) / prev.total_cost) * 100
    : 0;

  const avgDuration = d.prepare(`
    SELECT COALESCE(AVG(COALESCE(ended_at, ?) - started_at), 0) as avg_ms
    FROM sessions
    WHERE started_at >= ? AND started_at < ?
  `).get(Date.now(), from, to) as { avg_ms: number };

  const topModel = d.prepare(`
    SELECT model, SUM(cost) as model_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?
    GROUP BY model ORDER BY model_cost DESC LIMIT 1
  `).get(from, to) as { model: string; model_cost: number } | undefined;

  const toolStats = d.prepare(`
    SELECT
      COUNT(CASE WHEN event_type = 'tool_call' THEN 1 END) as calls,
      COUNT(CASE WHEN event_type = 'tool_result' THEN 1 END) as results
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?
  `).get(from, to) as { calls: number; results: number };

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
