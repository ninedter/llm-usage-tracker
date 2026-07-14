import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync, statSync } from "fs";
import type { AgentRecord, AgentEvent, AgentSession, SessionRecord, TokenUsage, MonitorStats, DbProvider, CodexIngestRow } from "@/types";
import { extractExecCommand, classifyCommand } from "@/lib/exec-classify";

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
      provider        TEXT NOT NULL DEFAULT 'anthropic',
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
      provider        TEXT NOT NULL DEFAULT 'anthropic',
      source_id       TEXT,
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
      provider        TEXT NOT NULL DEFAULT 'anthropic',
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

    -- Per-file tail cursor for the Codex rollout watcher (backfill + live poll)
    CREATE TABLE IF NOT EXISTS codex_ingest (
      file_path     TEXT PRIMARY KEY,
      byte_offset   INTEGER NOT NULL DEFAULT 0,
      thread_id     TEXT,
      last_seen_at  INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Forward-compatible migrations: add columns if they don't exist
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const colNames = new Set(agentCols.map(c => c.name));
  if (!colNames.has("subagent_type")) db.exec("ALTER TABLE agents ADD COLUMN subagent_type TEXT");
  if (!colNames.has("current_tool")) db.exec("ALTER TABLE agents ADD COLUMN current_tool TEXT");

  const eventCols = db.prepare("PRAGMA table_info(agent_events)").all() as { name: string }[];
  const eventColNames = new Set(eventCols.map(c => c.name));
  if (!eventColNames.has("session_id")) db.exec("ALTER TABLE agent_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  if (!eventColNames.has("provider")) db.exec("ALTER TABLE agent_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
  if (!eventColNames.has("source_id")) db.exec("ALTER TABLE agent_events ADD COLUMN source_id TEXT");

  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const sessionColNames = new Set(sessionCols.map(c => c.name));
  if (!sessionColNames.has("provider")) db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");

  const tokenCols = db.prepare("PRAGMA table_info(token_usage)").all() as { name: string }[];
  const tokenColNames = new Set(tokenCols.map(c => c.name));
  if (!tokenColNames.has("provider")) db.exec("ALTER TABLE token_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");

  // Provider/source_id indexes run after the ALTER TABLEs above so the
  // columns they reference are guaranteed to exist on pre-existing DBs too
  // (a fresh DB already has them from the CREATE TABLE block above).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_id ON agent_events(source_id) WHERE source_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_provider ON agent_events(provider);
    CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
  `);

  return db;
}

// --- Session CRUD ---

export function createSession(session: Omit<SessionRecord, "updated_at" | "provider">, provider: DbProvider = "anthropic"): SessionRecord {
  const now = Date.now();
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO sessions (id, status, project, cwd, entrypoint, provider, started_at, ended_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, session.status, session.project, session.cwd, session.entrypoint, provider, session.started_at, session.ended_at, now, session.metadata);
  return { ...session, provider, updated_at: now };
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
  // Re-read so the returned row (which gets broadcast over SSE) carries the
  // session's provider like every other agent read.
  return getAgent(agent.id) ?? { ...agent, created_at: now };
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
  // Carry the session's provider on every single-agent read: these rows are
  // broadcast over SSE, and the monitor's provider tabs drop agents whose
  // provider is missing.
  return getDb().prepare(`
    SELECT a.*, COALESCE(s.provider, 'anthropic') AS provider
    FROM agents a
    LEFT JOIN sessions s ON s.id = a.session_id
    WHERE a.id = ?
  `).get(id) as AgentRecord | null;
}

export function listAgents(filters?: {
  session_id?: string;
  status?: string;
  type?: string;
  provider?: DbProvider;
  limit?: number;
  offset?: number;
}): AgentRecord[] {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters?.session_id) { clauses.push("a.session_id = ?"); values.push(filters.session_id); }
  if (filters?.status) { clauses.push("a.status = ?"); values.push(filters.status); }
  if (filters?.type) { clauses.push("a.type = ?"); values.push(filters.type); }
  if (filters?.provider) { clauses.push("s.provider = ?"); values.push(filters.provider); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  // agents carries no provider column of its own — it inherits its session's.
  // Selecting it here is what lets the monitor badge and filter agents by
  // provider without a schema change.
  return getDb().prepare(`
    SELECT a.*, COALESCE(s.provider, 'anthropic') AS provider
    FROM agents a
    LEFT JOIN sessions s ON s.id = a.session_id
    ${where}
    ORDER BY a.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as AgentRecord[];
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

export function createEvent(
  event: Omit<AgentEvent, "id" | "created_at" | "provider" | "source_id">,
  provider: DbProvider = "anthropic",
  sourceId: string | null = null
): AgentEvent {
  const now = Date.now();
  const d = getDb();
  // Codex re-ingest passes the same sourceId for an already-seen record, so
  // OR IGNORE lets the partial unique index on source_id silently dedup it.
  // Claude events never pass sourceId, so their insert path is unchanged.
  const insertVerb = sourceId !== null ? "INSERT OR IGNORE" : "INSERT";
  const result = d.prepare(`
    ${insertVerb} INTO agent_events (agent_id, session_id, provider, source_id, event_type, tool_name, summary, content, files_affected, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.agent_id, event.session_id, provider, sourceId, event.event_type,
    event.tool_name, event.summary, event.content, event.files_affected,
    event.timestamp, now
  );
  return { ...event, id: Number(result.lastInsertRowid), provider, source_id: sourceId, created_at: now };
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

export function upsertTokenUsage(usage: Omit<TokenUsage, "provider">, provider: DbProvider = "anthropic"): void {
  getDb().prepare(`
    INSERT INTO token_usage (session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      provider = excluded.provider,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost = excluded.cost,
      updated_at = excluded.updated_at
  `).run(usage.session_id, usage.model, provider, usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.cost, usage.updated_at);
}

export function getSessionTokenUsage(sessionId: string): TokenUsage[] {
  return getDb().prepare("SELECT * FROM token_usage WHERE session_id = ?").all(sessionId) as TokenUsage[];
}

export function getTotalCost(): number {
  const row = getDb().prepare("SELECT COALESCE(SUM(cost), 0) as total FROM token_usage").get() as { total: number };
  return row.total;
}

// --- Codex Ingest Cursor ---

export function getCodexIngest(filePath: string): CodexIngestRow | null {
  const row = getDb().prepare("SELECT * FROM codex_ingest WHERE file_path = ?").get(filePath) as CodexIngestRow | undefined;
  return row ?? null;
}

export function upsertCodexIngest(row: CodexIngestRow): void {
  getDb().prepare(`
    INSERT INTO codex_ingest (file_path, byte_offset, thread_id, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      thread_id = excluded.thread_id,
      last_seen_at = excluded.last_seen_at,
      status = excluded.status
  `).run(row.file_path, row.byte_offset, row.thread_id, row.last_seen_at, row.status);
}

// --- Sessions with aggregated data ---

export function listSessions(limit = 50, provider?: DbProvider): AgentSession[] {
  return getDb().prepare(`
    SELECT
      s.id as session_id,
      s.status,
      s.project,
      s.entrypoint,
      s.provider,
      COUNT(DISTINCT a.id) as agent_count,
      COALESCE(SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END), 0) as working_count,
      COALESCE(SUM(CASE WHEN a.type = 'subagent' THEN 1 ELSE 0 END), 0) as subagent_count,
      (SELECT COUNT(*) FROM agent_events WHERE session_id = s.id) as event_count,
      COALESCE((SELECT SUM(cost) FROM token_usage WHERE session_id = s.id), 0) as total_cost,
      s.started_at as first_started,
      s.updated_at as last_activity
    FROM sessions s
    LEFT JOIN agents a ON a.session_id = s.id
    ${provider ? "WHERE s.provider = ?" : ""}
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(...pArg(provider), limit) as AgentSession[];
}

export function getSessionAgents(sessionId: string): AgentRecord[] {
  return getDb().prepare(
    "SELECT * FROM agents WHERE session_id = ? ORDER BY started_at ASC"
  ).all(sessionId) as AgentRecord[];
}

// --- Stats ---

export function getMonitorStats(provider?: DbProvider): MonitorStats {
  const d = getDb();
  const pa = pArg(provider);
  const eP = pSql("provider", provider);

  const sessions = d.prepare(
    `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM sessions WHERE 1=1${eP}`
  ).get(...pa) as { total: number; active: number };

  // agents inherits provider from its session, so scoping needs the join
  const agents = d.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN a.status = 'working' THEN 1 ELSE 0 END) as working
    FROM agents a
    LEFT JOIN sessions s ON s.id = a.session_id
    WHERE 1=1${pSql("s.provider", provider)}
  `).get(...pa) as { total: number; working: number };

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const events = d.prepare(`SELECT COUNT(*) as total FROM agent_events WHERE 1=1${eP}`).get(...pa) as { total: number };
  const eventsToday = d.prepare(
    `SELECT COUNT(*) as total FROM agent_events WHERE timestamp >= ?${eP}`
  ).get(todayStart.getTime(), ...pa) as { total: number };

  const cost = (d.prepare(
    `SELECT COALESCE(SUM(cost), 0) as total FROM token_usage WHERE 1=1${eP}`
  ).get(...pa) as { total: number }).total;

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

// --- App settings (key-value) ---

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

// --- Cleanup ---

export function completeSessionAgents(sessionId: string): void {
  const now = Date.now();
  getDb().prepare("UPDATE agents SET status = 'completed', ended_at = ? WHERE session_id = ? AND status IN ('working', 'idle')").run(now, sessionId);
}

// Delete every raw row tied to a session started before an absolute epoch-ms
// cutoff. Runs in one transaction. Leaves daily_usage intact.
export function deleteBefore(cutoffMs: number): import("@/types").PurgeCounts {
  const d = getDb();
  const run = d.transaction((): import("@/types").PurgeCounts => {
    const events = d.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const agents = d.prepare("DELETE FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const token_usage = d.prepare("DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)").run(cutoffMs).changes;
    const sessions = d.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoffMs).changes;
    return { sessions, agents, events, token_usage };
  });
  return run();
}

// Back-compat wrapper: existing callers pass a duration, not an absolute time.
export function deleteOldSessions(olderThanMs: number): number {
  return deleteBefore(Date.now() - olderThanMs).sessions;
}

// Count what deleteBefore(cutoffMs) would remove — same predicate, no writes.
export function previewPurge(cutoffMs: number): import("@/types").PurgeCounts {
  const d = getDb();
  const one = (sql: string) => (d.prepare(sql).get(cutoffMs) as { n: number }).n;
  return {
    sessions: one("SELECT COUNT(*) n FROM sessions WHERE started_at < ?"),
    agents: one("SELECT COUNT(*) n FROM agents WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
    events: one("SELECT COUNT(*) n FROM agent_events WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
    token_usage: one("SELECT COUNT(*) n FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ?)"),
  };
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

function dbFileBytes(): number {
  try { return statSync(getDbPath()).size; } catch { return 0; }
}

// Roll up [from, to) into daily_usage in <=92-day chunks. rollupDailyUsageRange
// caps its own scan at 92 days, so a single call over a longer span would skip
// the oldest slice — chunking guarantees the whole deleted span is summarized.
function rollupRangeChunked(from: number, to: number): void {
  const CHUNK = 92 * 86400000;
  let cursor = from;
  while (cursor < to) {
    const end = Math.min(cursor + CHUNK, to);
    rollupDailyUsageRange(cursor, end);
    cursor = end;
  }
}

// Age-based purge: summarize the deleted span into daily_usage (preserved),
// delete raw rows before cutoffMs, optionally VACUUM to reclaim file space.
export function purgeOlderThan(cutoffMs: number, opts?: { vacuum?: boolean }): import("@/types").PurgeResult {
  const d = getDb();
  const oldest = (d.prepare("SELECT MIN(started_at) m FROM sessions WHERE started_at < ?").get(cutoffMs) as { m: number | null }).m;
  if (oldest != null) rollupRangeChunked(oldest, cutoffMs);

  const before = dbFileBytes();
  const deleted = deleteBefore(cutoffMs);
  if (opts?.vacuum) d.exec("VACUUM");
  const after = dbFileBytes();
  return { deleted, bytes_freed: Math.max(0, before - after) };
}

// Full wipe: all raw tables plus daily_usage. Keeps app_settings (config).
export function purgeEverything(opts?: { vacuum?: boolean }): import("@/types").PurgeResult {
  const d = getDb();
  const before = dbFileBytes();
  const raw = clearAllMonitorData();
  const daily = d.prepare("DELETE FROM daily_usage").run().changes;
  if (opts?.vacuum) d.exec("VACUUM");
  const after = dbFileBytes();
  return {
    deleted: { sessions: raw.sessions, agents: raw.agents, events: raw.events, token_usage: raw.token_usage },
    bytes_freed: Math.max(0, before - after),
    daily_usage_cleared: daily,
  };
}

export function getStorageInfo(): import("@/types").StorageInfo {
  const d = getDb();
  const count = (t: string) => (d.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  const range = d.prepare("SELECT MIN(started_at) oldest, MAX(started_at) newest FROM sessions").get() as { oldest: number | null; newest: number | null };
  let walBytes = 0;
  try { walBytes = statSync(getDbPath() + "-wal").size; } catch { /* no WAL file yet */ }
  return {
    db_bytes: dbFileBytes(),
    wal_bytes: walBytes,
    counts: {
      sessions: count("sessions"),
      agents: count("agents"),
      agent_events: count("agent_events"),
      token_usage: count("token_usage"),
      daily_usage: count("daily_usage"),
    },
    oldest_ms: range.oldest,
    newest_ms: range.newest,
  };
}

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Runs the retention purge at most once per 24h. Returns the purge result when
// it ran, or null when disabled/throttled/misconfigured. Called from the stats
// maintenance path; skips VACUUM to stay off the hot path's lock.
export function runRetentionIfDue(nowMs: number): import("@/types").PurgeResult | null {
  if (getSetting("retention_enabled") !== "1") return null;
  const days = parseInt(getSetting("retention_days") || "30", 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  const last = parseInt(getSetting("last_purge_at") || "0", 10);
  if (nowMs - last < RETENTION_INTERVAL_MS) return null;

  const result = purgeOlderThan(nowMs - days * 86400000, { vacuum: false });
  setSetting("last_purge_at", String(nowMs));
  return result;
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

function localDateStr(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function rollupDailyUsage(dateStr?: string): void {
  const date = dateStr || localDateStr(Date.now());
  const dayStart = new Date(date + "T00:00:00").getTime();
  rollupDailyUsageRange(dayStart, dayStart + 86400000);
}

// Upserts daily_usage for every local calendar day in [from, to). Grouped in a
// single pass so analytics routes can backfill days the app wasn't running.
export function rollupDailyUsageRange(from: number, to: number): void {
  const d = getDb();
  // Bound the scan: daily_usage older than the cap is already immutable history
  const minFrom = Math.max(from, to - 92 * 86400000);

  const tokenRows = d.prepare(`
    SELECT
      strftime('%Y-%m-%d', s.started_at / 1000, 'unixepoch', 'localtime') as date,
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
    GROUP BY date, t.model, s.project
  `).all(minFrom, to) as {
    date: string; model: string; project: string;
    input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number;
    cost: number; session_count: number;
  }[];

  if (tokenRows.length === 0) return;

  const toolStats = d.prepare(`
    SELECT
      strftime('%Y-%m-%d', ae.timestamp / 1000, 'unixepoch', 'localtime') as date,
      COALESCE(s.project, '') as project,
      COUNT(*) as tool_calls,
      SUM(CASE WHEN ae.event_type = 'tool_result' AND ae.content LIKE '%error%' THEN 1 ELSE 0 END) as tool_failures
    FROM agent_events ae
    JOIN sessions s ON s.id = ae.session_id
    WHERE ae.event_type IN ('tool_call', 'tool_result')
      AND ae.timestamp >= ? AND ae.timestamp < ?
    GROUP BY date, s.project
  `).all(minFrom, to) as { date: string; project: string; tool_calls: number; tool_failures: number }[];

  const toolMap = new Map(toolStats.map(r => [`${r.date}|${r.project}`, r]));

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
      const tools = toolMap.get(`${row.date}|${row.project}`) || { tool_calls: 0, tool_failures: 0 };
      upsert.run(row.date, row.model, row.project, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.cost, row.session_count, tools.tool_calls, tools.tool_failures);
    }
  });
  runAll();
}

// --- Analytics Queries ---

// --- Provider scoping ---
//
// Every analytics query below takes an optional provider. `provider` lives on
// sessions / agent_events / token_usage, so scoping is a single extra clause.
// The one exception is daily_usage, which has no provider column — the two
// queries that read it fall back to a live token_usage join when scoped (see
// providerCostRows).
const pSql = (col: string, provider?: DbProvider) => (provider ? ` AND ${col} = ?` : "");
const pArg = (provider?: DbProvider): unknown[] => (provider ? [provider] : []);

// Per-day cost/tokens for a single provider, derived live from token_usage
// because the daily_usage rollup isn't provider-aware.
function providerCostRows(from: number, to: number, provider: DbProvider) {
  return getDb().prepare(`
    SELECT
      strftime('%Y-%m-%d', s.started_at / 1000, 'unixepoch', 'localtime') as date,
      SUM(t.cost) as cost,
      SUM(t.input_tokens + t.output_tokens) as tokens
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ? AND s.provider = ?
    GROUP BY date
  `).all(from, to, provider) as { date: string; cost: number; tokens: number }[];
}

export function getAnalyticsOverview(from: number, to: number, provider?: DbProvider): import("@/types").AnalyticsOverview {
  const d = getDb();
  const periodLength = to - from;
  const prevFrom = from - periodLength;
  const prevTo = from;
  const sP = pSql("s.provider", provider);
  const eP = pSql("provider", provider);
  const pa = pArg(provider);

  // Token/cost data (may be empty if no API usage tracking)
  const tokenData = d.prepare(`
    SELECT
      COALESCE(SUM(cost), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?${sP}
  `).get(from, to, ...pa) as { total_cost: number; total_input_tokens: number; total_output_tokens: number };

  // Session count from sessions table directly (independent of token data)
  const sessionData = d.prepare(`
    SELECT COUNT(*) as session_count
    FROM sessions
    WHERE started_at >= ? AND started_at < ?${eP}
  `).get(from, to, ...pa) as { session_count: number };

  const prev = d.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?${sP}
  `).get(prevFrom, prevTo, ...pa) as { total_cost: number };

  const costChangePct = prev.total_cost > 0
    ? ((tokenData.total_cost - prev.total_cost) / prev.total_cost) * 100
    : 0;

  const avgDuration = d.prepare(`
    SELECT COALESCE(AVG(COALESCE(ended_at, ?) - started_at), 0) as avg_ms
    FROM sessions
    WHERE started_at >= ? AND started_at < ?${eP}
  `).get(Date.now(), from, to, ...pa) as { avg_ms: number };

  const topModel = d.prepare(`
    SELECT model, SUM(cost) as model_cost
    FROM token_usage t
    JOIN sessions s ON s.id = t.session_id
    WHERE s.started_at >= ? AND s.started_at < ?${sP}
    GROUP BY model ORDER BY model_cost DESC LIMIT 1
  `).get(from, to, ...pa) as { model: string; model_cost: number } | undefined;

  const toolStats = d.prepare(`
    SELECT
      COUNT(CASE WHEN event_type = 'tool_call' THEN 1 END) as calls,
      COUNT(CASE WHEN event_type = 'tool_result' THEN 1 END) as results
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?${eP}
  `).get(from, to, ...pa) as { calls: number; results: number };

  const toolFailures = d.prepare(`
    SELECT COUNT(*) as failures
    FROM agent_events
    WHERE event_type = 'tool_result' AND timestamp >= ? AND timestamp < ?${eP}
      AND (summary LIKE '%error%' OR summary LIKE '%fail%' OR summary LIKE '%Error%')
  `).get(from, to, ...pa) as { failures: number };

  const successRate = toolStats.calls > 0
    ? ((toolStats.calls - toolFailures.failures) / toolStats.calls) * 100
    : 100;

  return {
    total_cost: tokenData.total_cost,
    cost_change_pct: Math.round(costChangePct * 10) / 10,
    session_count: sessionData.session_count,
    avg_session_duration_ms: Math.round(avgDuration.avg_ms),
    total_input_tokens: tokenData.total_input_tokens,
    total_output_tokens: tokenData.total_output_tokens,
    top_model: topModel?.model || "N/A",
    top_model_cost_pct: topModel && tokenData.total_cost > 0
      ? Math.round((topModel.model_cost / tokenData.total_cost) * 100)
      : 0,
    tool_call_count: toolStats.calls,
    tool_success_rate: Math.round(successRate * 10) / 10,
  };
}

export function getAnalyticsTrends(from: number, to: number, granularity: "hourly" | "daily", provider?: DbProvider): import("@/types").TrendPoint[] {
  const d = getDb();
  const bucketExpr = granularity === "daily" ? "%Y-%m-%d" : "%Y-%m-%dT%H:00";
  const eP = pSql("provider", provider);
  const pa = pArg(provider);

  // Sessions counted from the sessions table directly — a day with sessions
  // must show even when no token/cost data was captured for it.
  const sessionRows = d.prepare(`
    SELECT strftime('${bucketExpr}', started_at / 1000, 'unixepoch', 'localtime') as date, COUNT(*) as n
    FROM sessions
    WHERE started_at >= ? AND started_at < ?${eP}
    GROUP BY date
  `).all(from, to, ...pa) as { date: string; n: number }[];

  const eventRows = d.prepare(`
    SELECT strftime('${bucketExpr}', timestamp / 1000, 'unixepoch', 'localtime') as date, COUNT(*) as n
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?${eP}
    GROUP BY date
  `).all(from, to, ...pa) as { date: string; n: number }[];

  // daily_usage has no provider column, so a scoped request reads token_usage
  // live instead of the rollup.
  const costRows = granularity !== "daily"
    ? []
    : provider
      ? providerCostRows(from, to, provider)
      : d.prepare(`
          SELECT date, SUM(cost) as cost, SUM(input_tokens + output_tokens) as tokens
          FROM daily_usage
          WHERE date >= ? AND date <= ?
          GROUP BY date
        `).all(localDateStr(from), localDateStr(to)) as { date: string; cost: number; tokens: number }[];

  const sessions = new Map(sessionRows.map(r => [r.date, r.n]));
  const events = new Map(eventRows.map(r => [r.date, r.n]));
  const costs = new Map(costRows.map(r => [r.date, r]));

  // Gap-fill every bucket in the range so sparse data doesn't collapse into a
  // single full-width bar. For open-ended ranges (from=0) start at the first
  // bucket that has data.
  const stepMs = granularity === "daily" ? 86400000 : 3600000;
  const allDates = [...sessions.keys(), ...events.keys(), ...costs.keys()].sort();
  const maxBuckets = granularity === "daily" ? 366 : 168;
  let start = new Date(Math.max(from, to - maxBuckets * stepMs));
  if (from === 0 && allDates.length > 0) {
    const firstMs = new Date(granularity === "daily" ? allDates[0] + "T00:00:00" : allDates[0]).getTime();
    start = new Date(Math.max(firstMs, start.getTime()));
  }
  if (granularity === "daily") start.setHours(0, 0, 0, 0);
  else start.setMinutes(0, 0, 0);

  const points: import("@/types").TrendPoint[] = [];
  const cursor = start;
  while (cursor.getTime() <= to && points.length <= maxBuckets) {
    const key = granularity === "daily"
      ? localDateStr(cursor.getTime())
      : `${localDateStr(cursor.getTime())}T${String(cursor.getHours()).padStart(2, "0")}:00`;
    const cost = costs.get(key);
    points.push({
      date: key,
      cost: cost?.cost || 0,
      tokens: cost?.tokens || 0,
      events: events.get(key) || 0,
      sessions: sessions.get(key) || 0,
    });
    if (granularity === "daily") cursor.setDate(cursor.getDate() + 1);
    else cursor.setHours(cursor.getHours() + 1);
  }

  return points;
}

export function getSessionAnalytics(from: number, to: number, sort = "started_at", order = "desc", limit = 20, offset = 0, provider?: DbProvider): import("@/types").SessionAnalyticRow[] {
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
      s.provider,
      (COALESCE(s.ended_at, ?) - s.started_at) as duration_ms,
      COALESCE(tu.total_tokens, 0) as total_tokens,
      COALESCE(tu.cost, 0) as cost,
      COALESCE(ec.tool_count, 0) as tool_count,
      s.started_at
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, SUM(input_tokens + output_tokens) AS total_tokens, SUM(cost) AS cost
      FROM token_usage GROUP BY session_id
    ) tu ON tu.session_id = s.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS tool_count
      FROM agent_events WHERE event_type = 'tool_call' GROUP BY session_id
    ) ec ON ec.session_id = s.id
    WHERE s.started_at >= ? AND s.started_at < ?${pSql("s.provider", provider)}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(Date.now(), from, to, ...pArg(provider), limit, offset) as import("@/types").SessionAnalyticRow[];
}

export function getToolAnalytics(from: number, to: number, provider?: DbProvider): import("@/types").ToolAnalytics {
  const d = getDb();
  const eP = pSql("provider", provider);
  const pa = pArg(provider);

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
      AND timestamp >= ? AND timestamp < ?${eP}
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all(from, to, ...pa) as import("@/types").ToolAnalyticEntry[];

  // One grouped scan for failures (SQLite LIKE is already case-insensitive
  // for ASCII, so two patterns cover error/Error/FAIL/fail).
  const failureRows = d.prepare(`
    SELECT tool_name, COUNT(*) as cnt FROM agent_events
    WHERE event_type = 'tool_result' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
      AND (summary LIKE '%error%' OR summary LIKE '%fail%')
    GROUP BY tool_name
  `).all(from, to, ...pa) as { tool_name: string; cnt: number }[];
  const failures = new Map(failureRows.map(r => [r.tool_name, r.cnt]));

  // One window-function pass for durations: pair each tool_result with the
  // nearest PRECEDING tool_call of the same (agent, tool) within 300s. The
  // old per-tool self-join was O(n²) per tool (6.1s at 58K events); this is
  // a single ordered scan (~80ms) and pairs calls/results more accurately.
  const durationRows = d.prepare(`
    WITH seq AS (
      SELECT tool_name, event_type, timestamp,
        LAG(event_type) OVER w AS prev_type,
        LAG(timestamp) OVER w AS prev_ts
      FROM agent_events
      WHERE event_type IN ('tool_call','tool_result') AND tool_name IS NOT NULL
        AND timestamp >= ? AND timestamp < ?${eP}
      WINDOW w AS (PARTITION BY agent_id, tool_name ORDER BY timestamp)
    )
    SELECT tool_name, AVG(timestamp - prev_ts) AS avg_ms
    FROM seq
    WHERE event_type = 'tool_result' AND prev_type = 'tool_call'
      AND timestamp - prev_ts BETWEEN 0 AND 300000
    GROUP BY tool_name
  `).all(from, to, ...pa) as { tool_name: string; avg_ms: number | null }[];
  const durations = new Map(durationRows.map(r => [r.tool_name, r.avg_ms]));

  for (const tool of tools) {
    tool.failure_count = failures.get(tool.tool_name) ?? 0;
    tool.success_count = tool.call_count - tool.failure_count;
    tool.success_rate = tool.call_count > 0
      ? Math.round((tool.success_count / tool.call_count) * 1000) / 10
      : 100;
    tool.avg_duration_ms = Math.round(durations.get(tool.tool_name) ?? 0);
  }

  const timeline = d.prepare(`
    SELECT
      tool_name,
      timestamp,
      1 as success,
      0 as duration_ms
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(from, to, ...pa) as import("@/types").ToolTimelinePoint[];

  return { tools, timeline: timeline.reverse() };
}

export function getFileAnalytics(from: number, to: number, provider?: DbProvider): import("@/types").FileAnalytics {
  const d = getDb();

  const rows = d.prepare(`
    SELECT files_affected, tool_name
    FROM agent_events
    WHERE files_affected IS NOT NULL AND files_affected != ''
      AND timestamp >= ? AND timestamp < ?${pSql("provider", provider)}
  `).all(from, to, ...pArg(provider)) as { files_affected: string; tool_name: string | null }[];

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

export function getModelAnalytics(from: number, to: number, provider?: DbProvider): import("@/types").ModelAnalytics {
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
    WHERE s.started_at >= ? AND s.started_at < ?${pSql("s.provider", provider)}
    GROUP BY t.model
    ORDER BY cost DESC
  `).all(from, to, ...pArg(provider)) as import("@/types").ModelEntry[];

  // Same daily_usage limitation as getAnalyticsTrends: no provider column, so a
  // scoped request bucket-sums token_usage live instead.
  const trend = provider
    ? d.prepare(`
        SELECT
          strftime('%Y-%m-%d', s.started_at / 1000, 'unixepoch', 'localtime') as date,
          t.model,
          SUM(t.cost) as cost,
          SUM(t.input_tokens + t.output_tokens) as tokens
        FROM token_usage t
        JOIN sessions s ON s.id = t.session_id
        WHERE s.started_at >= ? AND s.started_at < ? AND s.provider = ?
        GROUP BY date, t.model
        ORDER BY date ASC
      `).all(from, to, provider) as import("@/types").ModelTrendPoint[]
    : d.prepare(`
        SELECT date, model, SUM(cost) as cost, SUM(input_tokens + output_tokens) as tokens
        FROM daily_usage
        WHERE date >= ? AND date <= ?
        GROUP BY date, model
        ORDER BY date ASC
      `).all(localDateStr(from), localDateStr(to)) as import("@/types").ModelTrendPoint[];

  return { models, trend };
}

// Tool names with one unambiguous intent, across BOTH providers (Claude's
// dedicated tools + Codex's web_search / apply_patch). Codex's `exec` fits
// neither bucket by name — it's a shell that both reads and writes — so exec
// calls are classified per-command by verb (see classifyCommand) in
// getUsageInsights instead.
const EXPLORE_TOOLS = "('Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'web_search')";
const MODIFY_TOOLS = "('Edit', 'Write', 'NotebookEdit', 'apply_patch')";

export function getUsageInsights(from: number, to: number, provider?: DbProvider): import("@/types").UsageInsights {
  const d = getDb();
  const eP = pSql("provider", provider);
  const aeP = pSql("ae.provider", provider);
  const sP = pSql("s.provider", provider);
  const pa = pArg(provider);

  const heatmap = d.prepare(`
    SELECT
      CAST(strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as dow,
      CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
      COUNT(*) as events
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?${eP}
    GROUP BY dow, hour
  `).all(from, to, ...pa) as import("@/types").HeatmapCell[];

  const projects = d.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id) as sessions,
      COUNT(ae.id) as events,
      SUM(CASE WHEN ae.event_type = 'tool_call' THEN 1 ELSE 0 END) as tool_calls,
      COUNT(DISTINCT strftime('%Y-%m-%d', ae.timestamp / 1000, 'unixepoch', 'localtime')) as active_days,
      MAX(s.updated_at) as last_active
    FROM sessions s
    LEFT JOIN agent_events ae ON ae.session_id = s.id AND ae.timestamp >= ? AND ae.timestamp < ?${aeP}
    WHERE s.started_at >= ? AND s.started_at < ?${sP}
    GROUP BY s.project
    ORDER BY events DESC
    LIMIT 12
  `).all(from, to, ...pa, from, to, ...pa) as import("@/types").ProjectUsage[];

  const dayRows = d.prepare(`
    SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date, COUNT(*) as events
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?${eP}
    GROUP BY date
    ORDER BY events DESC
  `).all(from, to, ...pa) as { date: string; events: number }[];

  const peakHourRow = d.prepare(`
    SELECT CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour, COUNT(*) as events
    FROM agent_events
    WHERE timestamp >= ? AND timestamp < ?${eP}
    GROUP BY hour
    ORDER BY events DESC
    LIMIT 1
  `).get(from, to, ...pa) as { hour: number; events: number } | undefined;

  // Sessions that never received a SessionEnd hook have ended_at NULL — clamp
  // their duration to the last observed event instead of "still running"
  const sessionAgg = d.prepare(`
    SELECT
      COUNT(*) as n,
      COALESCE(MAX(
        COALESCE(
          s.ended_at,
          (SELECT MAX(ae.timestamp) FROM agent_events ae WHERE ae.session_id = s.id),
          s.started_at
        ) - s.started_at
      ), 0) as longest_ms
    FROM sessions s
    WHERE s.started_at >= ? AND s.started_at < ?${sP}
  `).get(from, to, ...pa) as { n: number; longest_ms: number };

  const eventCount = d.prepare(
    `SELECT COUNT(*) as n FROM agent_events WHERE timestamp >= ? AND timestamp < ?${eP}`
  ).get(from, to, ...pa) as { n: number };

  const toolMix = d.prepare(`
    SELECT
      SUM(CASE WHEN tool_name IN ${EXPLORE_TOOLS} THEN 1 ELSE 0 END) as explore_calls,
      SUM(CASE WHEN tool_name IN ${MODIFY_TOOLS} THEN 1 ELSE 0 END) as modify_calls
    FROM agent_events
    WHERE event_type = 'tool_call' AND timestamp >= ? AND timestamp < ?${eP}
  `).get(from, to, ...pa) as { explore_calls: number | null; modify_calls: number | null };

  // Codex `exec` is a shell that both reads and writes, so bucketing it by
  // tool name would be a lie. Classify each call by its command verb instead;
  // unrecognised verbs (node, npm, docker …) deliberately count as neither.
  // substr keeps the scan light — the verb lives in the first bytes of the
  // stored exec_command input.
  let execExplore = 0;
  let execModify = 0;
  const execHeads = d.prepare(`
    SELECT substr(content, 1, 300) as head
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name = 'exec' AND content IS NOT NULL
      AND timestamp >= ? AND timestamp < ?${eP}
  `).all(from, to, ...pa) as { head: string }[];
  for (const row of execHeads) {
    const cmd = extractExecCommand(row.head);
    const cls = cmd ? classifyCommand(cmd) : null;
    if (cls === "explore") execExplore++;
    else if (cls === "modify") execModify++;
  }

  const topTool = d.prepare(`
    SELECT tool_name, COUNT(*) as n
    FROM agent_events
    WHERE event_type = 'tool_call' AND tool_name IS NOT NULL AND timestamp >= ? AND timestamp < ?${eP}
    GROUP BY tool_name ORDER BY n DESC LIMIT 1
  `).get(from, to, ...pa) as { tool_name: string; n: number } | undefined;

  // Streak: consecutive local days with activity, counting back from today
  // (independent of the selected range so it reads as "as of now")
  const recentDays = d.prepare(`
    SELECT DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date
    FROM agent_events
    WHERE timestamp >= ?${eP}
  `).all(Date.now() - 60 * 86400000, ...pa) as { date: string }[];
  const daySet = new Set(recentDays.map(r => r.date));
  let streak = 0;
  const cursor = new Date();
  // A day without activity yet (early morning) shouldn't zero the streak
  if (!daySet.has(localDateStr(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (daySet.has(localDateStr(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const effectiveFrom = from > 0
    ? from
    : (dayRows.length > 0
        ? Math.min(...dayRows.map(r => new Date(r.date + "T00:00:00").getTime()))
        : to);
  const totalDays = Math.max(1, Math.ceil((to - effectiveFrom) / 86400000));

  return {
    heatmap,
    projects,
    stats: {
      active_days: dayRows.length,
      total_days: totalDays,
      current_streak: streak,
      busiest_day: dayRows.length > 0 ? { date: dayRows[0].date, events: dayRows[0].events } : null,
      peak_hour: peakHourRow ?? null,
      longest_session_ms: sessionAgg.longest_ms,
      avg_events_per_session: sessionAgg.n > 0 ? Math.round(eventCount.n / sessionAgg.n) : 0,
      explore_calls: (toolMix.explore_calls || 0) + execExplore,
      modify_calls: (toolMix.modify_calls || 0) + execModify,
      top_tool: topTool?.tool_name ?? null,
    },
  };
}
