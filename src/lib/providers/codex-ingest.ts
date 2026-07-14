import { openSync, readSync, closeSync, fstatSync } from "fs";
import type { AgentEvent } from "@/types";
import {
  getDb,
  createSession,
  createAgent,
  createEvent,
  getAgent,
  upsertTokenUsage,
  getCodexIngest,
  upsertCodexIngest,
} from "@/lib/db";
import {
  parseRolloutLines,
  readSessionInfo,
  readTokenTotals,
  readLastTimestamp,
  mapEventRecord,
} from "@/lib/providers/codex-rollout";

export interface IngestResult {
  inserted: number;
  newByteOffset: number;
  threadId: string | null;
}

// A rollout file untouched for this long is treated as a finished session. The
// monitor hides `archived` agents and shows `working` ones, so without this
// every backfilled session would sit in the live view as a fake busy agent.
export const LIVE_WINDOW_MS = 5 * 60_000;

// Codex writes one rollout file per thread, so a thread id round-trips to both
// ids. That's what lets a tail chunk (which has no session_meta) re-attach to
// its session using only the thread_id stored on the cursor.
const sessionIdFor = (threadId: string) => `codex:${threadId}`;
const agentIdFor = (threadId: string) => `codex:${threadId}`;

// Read only the bytes appended past `fromByte`, and only up to the last
// newline — a half-written trailing line is left for the next tick.
function readAppended(filePath: string, fromByte: number): { text: string; consumed: number; mtimeMs: number } {
  const fd = openSync(filePath, "r");
  try {
    const st = fstatSync(fd);
    const size = st.size;
    if (size <= fromByte) return { text: "", consumed: fromByte, mtimeMs: st.mtimeMs };

    const len = size - fromByte;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, fromByte);

    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { text: "", consumed: fromByte, mtimeMs: st.mtimeMs }; // no complete line yet
    return {
      text: buf.subarray(0, lastNl + 1).toString("utf8"),
      consumed: fromByte + lastNl + 1,
      mtimeMs: st.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Close out Codex sessions whose rollout file has gone quiet.
 *
 * Runs every watcher tick, because a session going idle produces no new bytes —
 * so ingest alone would never notice. Sessions are closed at their real last
 * event time, which lets the existing archiveStaleAgents() sweep retire them
 * from the live monitor exactly the way it retires finished Claude agents.
 */
export function closeIdleCodexSessions(now: number = Date.now()): number {
  const d = getDb();
  const cutoff = now - LIVE_WINDOW_MS;

  const stale = d.prepare(`
    SELECT s.id AS id,
           (SELECT MAX(timestamp) FROM agent_events WHERE session_id = s.id) AS last_ts
    FROM sessions s
    WHERE s.provider = 'openai' AND s.status = 'active' AND s.updated_at < ?
  `).all(cutoff) as { id: string; last_ts: number | null }[];

  if (stale.length === 0) return 0;

  const closeSession = d.prepare(
    "UPDATE sessions SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?"
  );
  const closeAgents = d.prepare(
    "UPDATE agents SET status = 'completed', ended_at = ?, current_tool = NULL WHERE session_id = ? AND status IN ('working', 'idle')"
  );

  d.transaction((rows: typeof stale) => {
    for (const r of rows) {
      const endedAt = r.last_ts ?? cutoff;
      closeSession.run(endedAt, endedAt, r.id);
      closeAgents.run(endedAt, r.id);
    }
  })(stale);

  return stale.length;
}

/**
 * Ingest a single Codex rollout file from its stored cursor to EOF.
 *
 * Idempotent: every event carries a deterministic source_id, and the
 * agent_events partial unique index + INSERT OR IGNORE mean re-reading a file
 * can never duplicate. `onEvent` fires only for genuinely new rows, so the
 * watcher can broadcast them straight to the live monitor.
 */
export function ingestRolloutFile(filePath: string, onEvent?: (e: AgentEvent) => void): IngestResult {
  const cursor = getCodexIngest(filePath);
  const fromByte = cursor?.byte_offset ?? 0;

  const { text, consumed, mtimeMs } = readAppended(filePath, fromByte);
  if (!text) {
    return { inserted: 0, newByteOffset: fromByte, threadId: cursor?.thread_id ?? null };
  }

  const records = parseRolloutLines(text);
  const info = readSessionInfo(records);
  let threadId = cursor?.thread_id || null;

  // First sight of this file: its session_meta creates the session + agent.
  if (info && !threadId) {
    threadId = info.thread_id;
    const sessionId = sessionIdFor(threadId);
    const agentId = agentIdFor(threadId);

    // Subagent threads are their own session in v1; the parent link is kept in
    // metadata rather than agents.parent_agent_id, whose FK would blow up when
    // a child file is ingested before its parent.
    const metadata = info.is_subagent
      ? JSON.stringify({ parent_thread_id: info.root_id, subagent: true })
      : null;

    createSession(
      {
        id: sessionId,
        status: "active",
        project: info.project,
        cwd: info.cwd,
        entrypoint: info.entrypoint,
        started_at: info.started_at,
        ended_at: null,
        metadata,
      },
      "openai"
    );

    if (!getAgent(agentId)) {
      createAgent({
        id: agentId,
        session_id: sessionId,
        parent_agent_id: null,
        type: "main",
        subagent_type: info.is_subagent ? "codex" : null,
        description: info.description,
        status: "working",
        current_tool: null,
        started_at: info.started_at,
        ended_at: null,
        metadata,
      });
    }
  }

  // A tail chunk that arrived before we ever saw session_meta: bank the offset
  // and wait (shouldn't happen — session_meta is the first line of the file).
  if (!threadId) {
    upsertCodexIngest({
      file_path: filePath,
      byte_offset: consumed,
      thread_id: "",
      last_seen_at: Date.now(),
      status: "active",
    });
    return { inserted: 0, newByteOffset: consumed, threadId: null };
  }

  const sessionId = sessionIdFor(threadId);
  const agentId = agentIdFor(threadId);

  const d = getDb();
  // createEvent() does INSERT OR IGNORE but still returns a row on a dedup, so
  // it can't tell us whether it actually wrote. Check first — that keeps the
  // inserted count honest and stops us re-broadcasting old events.
  const alreadySeen = d.prepare("SELECT 1 AS x FROM agent_events WHERE source_id = ? LIMIT 1");

  let inserted = 0;
  let currentTool: string | null = null;

  for (const record of records) {
    for (const ev of mapEventRecord(record, threadId)) {
      // Track the in-flight tool across every mapped event (not just new ones)
      // so the monitor can show what a live Codex agent is doing right now.
      if (ev.event_type === "tool_call") currentTool = ev.tool_name;
      else if (ev.event_type === "tool_result") currentTool = null;

      if (!ev.source_id || alreadySeen.get(ev.source_id)) continue;

      const created = createEvent(
        {
          agent_id: agentId,
          session_id: sessionId,
          event_type: ev.event_type,
          tool_name: ev.tool_name,
          summary: ev.summary,
          content: ev.content,
          files_affected: ev.files_affected.length ? JSON.stringify(ev.files_affected) : null,
          timestamp: ev.timestamp,
        },
        "openai",
        ev.source_id
      );

      inserted++;
      onEvent?.(created);
    }
  }

  const totals = readTokenTotals(records);
  if (totals) {
    upsertTokenUsage(
      {
        session_id: sessionId,
        model: totals.model,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cache_read_tokens: totals.cache_read_tokens,
        cache_write_tokens: totals.cache_write_tokens,
        cost: 0, // Codex runs on a flat subscription — a dollar figure would be fiction
        updated_at: Date.now(),
      },
      "openai"
    );
  }

  // Drive session/agent state from the LOG's clock, never Date.now(): a rollout
  // file last written 60 days ago is finished history, and stamping it as
  // "updated now / still working" would park 90 days of sessions in the live
  // monitor as fake busy agents.
  const lastTs = readLastTimestamp(records) || mtimeMs;
  const isLive = Date.now() - mtimeMs < LIVE_WINDOW_MS;

  if (isLive) {
    d.prepare("UPDATE sessions SET updated_at = ?, status = 'active', ended_at = NULL WHERE id = ?")
      .run(lastTs, sessionId);
    d.prepare("UPDATE agents SET status = 'working', current_tool = ?, ended_at = NULL WHERE id = ?")
      .run(currentTool, agentId);
  } else {
    d.prepare("UPDATE sessions SET updated_at = ?, status = 'completed', ended_at = ? WHERE id = ?")
      .run(lastTs, lastTs, sessionId);
    d.prepare("UPDATE agents SET status = 'completed', ended_at = ?, current_tool = NULL WHERE id = ?")
      .run(lastTs, agentId);
  }

  upsertCodexIngest({
    file_path: filePath,
    byte_offset: consumed,
    thread_id: threadId,
    last_seen_at: Date.now(),
    status: isLive ? "active" : "done",
  });

  return { inserted, newByteOffset: consumed, threadId };
}
