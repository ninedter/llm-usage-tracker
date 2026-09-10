/**
 * Hook payload -> hub ingest event.
 *
 * Field semantics are exactly the ones `hooks/agent-monitor-hook.py`
 * (`build_body`) already produces and `POST /api/monitor/events` already
 * accepts, plus the two things the hub's `/api/ingest/v1` needs and the local
 * path doesn't: a `timestamp` and a stable `source_id`.
 */
import { createHash } from "node:crypto";

/** Bounds on what a single event may put in the spool (and in the hub's DB). */
export const MAX_SUMMARY = 500;
export const MAX_CONTENT = 4_000;
export const MAX_FILES = 50;

export class InvalidEventError extends Error {}

function str(value, max) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return max ? text.slice(0, max) : text;
}

function files(value) {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  const out = list.filter((f) => typeof f === "string" && f).slice(0, MAX_FILES);
  return out.length ? out : null;
}

/**
 * The idempotency key. A caller-supplied `source_id` always wins; otherwise we
 * hash the event's own content *including its millisecond timestamp*, so:
 *   - re-delivering the same spooled entry (retry, restart, replayed batch) is
 *     always a duplicate the hub drops, and
 *   - two genuinely different events can't collide unless they are identical
 *     down to the same millisecond, in which case nothing downstream could
 *     tell them apart anyway.
 */
export function deriveSourceId(event) {
  const canonical = JSON.stringify([
    event.agent_id, event.session_id, event.event_type, event.tool_name,
    event.summary, event.content, event.files_affected,
    event.agent_project, event.agent_entrypoint, event.agent_cwd,
    event.provider, event.timestamp,
  ]);
  return "edge:" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Normalize one inbound payload into the exact JSON the hub expects.
 * @throws {InvalidEventError} when the two fields every ingest path requires are missing.
 */
export function normalizeEvent(raw, opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidEventError("event must be an object");
  }
  const now = opts.now ?? Date.now();

  const agentId = str(raw.agent_id ?? raw.session_id, 256);
  if (!agentId) throw new InvalidEventError("agent_id is required");
  const eventType = str(raw.event_type, 64);
  if (!eventType) throw new InvalidEventError("event_type is required");

  const timestamp = Number.isFinite(raw.timestamp) && raw.timestamp > 0 ? Math.floor(raw.timestamp) : now;
  // Anything that isn't one of the hub's two providers would be coerced to
  // "anthropic" server-side; do it here so the spool matches what lands.
  const provider = raw.provider === "openai" ? "openai" : "anthropic";

  const event = {
    source_id: null,
    agent_id: agentId,
    session_id: str(raw.session_id, 256) || agentId,
    event_type: eventType,
    tool_name: str(raw.tool_name, 128),
    summary: str(raw.summary, MAX_SUMMARY),
    content: str(raw.content, MAX_CONTENT),
    files_affected: files(raw.files_affected),
    agent_project: str(raw.agent_project, 256) ?? "",
    agent_entrypoint: str(raw.agent_entrypoint, 128) ?? "",
    agent_cwd: str(raw.agent_cwd, 1_024) ?? "",
    provider,
    timestamp,
  };

  const supplied = str(raw.source_id, 256);
  event.source_id = supplied || deriveSourceId(event);
  return event;
}

/** Pull an events array out of either intake shape: `{events:[...]}` or a bare event. */
export function eventsFromPayload(payload) {
  if (payload && typeof payload === "object" && Array.isArray(payload.events)) return payload.events;
  return [payload];
}
