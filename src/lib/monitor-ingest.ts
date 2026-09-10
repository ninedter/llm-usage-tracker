import {
  createAgent,
  createEvent,
  completeSessionAgents,
  ensureAgent,
  ensureSession,
  getMainAgent,
  getWorkingSubagents,
  hasEventSource,
  rollupDailyUsage,
  updateAgent,
  updateSession,
} from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import { LOCAL_MACHINE, type MachineCtx } from "@/lib/machine";
import type { AgentEvent, DbProvider } from "@/types";

/**
 * One agent-monitor event, in the shape both ingest paths speak.
 *
 * `POST /api/monitor/events` (local hooks, unauthenticated) and
 * `POST /api/ingest/v1` (authenticated, batched, from a remote edge) apply the
 * *same* lifecycle semantics — session start/end, agent auto-registration,
 * subagent routing, status transitions. The only differences are which machine
 * the rows are stamped with and whether an idempotency key is supplied, so the
 * semantics live here rather than being copy-pasted into the hub route.
 */
export interface MonitorEventInput {
  agent_id: string;
  event_type: string;
  session_id?: string | null;
  tool_name?: string | null;
  summary?: string | null;
  content?: string | null;
  files_affected?: string[] | string | null;
  agent_project?: string | null;
  agent_entrypoint?: string | null;
  agent_cwd?: string | null;
  provider?: DbProvider;
  /** Epoch ms from the edge; defaults to now for the local path. */
  timestamp?: number | null;
  /** Stable idempotency key. Required by the hub, absent for local hooks. */
  source_id?: string | null;
}

export interface ProcessResult {
  /** Null when the event was a replay of an already-recorded source_id. */
  event: AgentEvent | null;
  duplicate: boolean;
}

export interface ProcessOptions {
  machine?: MachineCtx;
}

/** Validate the two fields every path requires. Returns null when input is fine. */
export function validateEventInput(input: Partial<MonitorEventInput>): string | null {
  if (typeof input.agent_id !== "string" || !input.agent_id) return "agent_id is required";
  if (typeof input.event_type !== "string" || !input.event_type) return "event_type is required";
  return null;
}

let lastRollup = 0;

/** Daily rollup, at most once per 60s across every ingest path. */
export function maybeRollupDaily(nowMs = Date.now()): void {
  if (nowMs - lastRollup <= 60_000) return;
  lastRollup = nowMs;
  try { rollupDailyUsage(); } catch { /* ignore rollup errors */ }
}

export function processMonitorEvent(input: MonitorEventInput, opts: ProcessOptions = {}): ProcessResult {
  const machine = opts.machine ?? LOCAL_MACHINE;
  // Never trust an inbound provider string: it lands in a column the whole
  // analytics layer filters on.
  const provider: DbProvider = input.provider === "openai" || input.provider === "anthropic" ? input.provider : "anthropic";
  const sourceId = input.source_id ?? null;
  const {
    agent_id, event_type, tool_name, summary, content,
    files_affected, agent_project, agent_entrypoint, agent_cwd,
  } = input;

  // Replay check comes first, so a retried batch doesn't re-run the side
  // effects below — subagent_start in particular mints a brand-new agent row
  // every time it runs.
  if (sourceId !== null && hasEventSource(machine.id, sourceId)) {
    return { event: null, duplicate: true };
  }

  const sid = input.session_id || agent_id;
  const ts = typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
    ? input.timestamp
    : Date.now();

  // --- Handle session lifecycle events ---
  if (event_type === "session_start") {
    const session = ensureSession(sid, agent_project ?? undefined, agent_cwd ?? undefined, agent_entrypoint ?? undefined, machine, provider);
    broadcastEvent({ type: "session_created", data: session });

    // Also ensure the main agent exists
    const agent = ensureAgent(agent_id, sid, agent_project ?? undefined, agent_entrypoint ?? undefined, machine, provider);
    if (agent.created_at === agent.started_at) {
      broadcastEvent({ type: "agent_created", data: agent });
    }
  } else if (event_type === "session_end") {
    // Mark session completed
    const session = updateSession(sid, { status: "completed", ended_at: Date.now() }, machine.id);
    if (session) broadcastEvent({ type: "session_updated", data: session });

    // Complete all running agents in this session
    completeSessionAgents(sid, machine.id);

    // Update the main agent status
    const mainAgent = getMainAgent(sid, machine.id);
    if (mainAgent) {
      const updated = updateAgent(mainAgent.id, { status: "completed", ended_at: Date.now(), current_tool: null }, machine.id);
      if (updated) broadcastEvent({ type: "agent_updated", data: updated });
    }
  } else {
    // For all other events, ensure session and agent exist
    ensureSession(sid, agent_project ?? undefined, agent_cwd ?? undefined, agent_entrypoint ?? undefined, machine, provider);
    const agent = ensureAgent(agent_id, sid, agent_project ?? undefined, agent_entrypoint ?? undefined, machine, provider);
    if (agent.created_at === agent.started_at) {
      broadcastEvent({ type: "agent_created", data: agent });
    }
  }

  // --- Route events to the correct agent ---
  // When there are working subagents and the event came from the session's main agent,
  // attribute tool_call/tool_result events to the most recent working subagent.
  // Note: stop events are NOT routed — Stop means the main agent paused, not a subagent.
  let effectiveAgentId = agent_id;
  if (
    (event_type === "tool_call" || event_type === "tool_result") &&
    tool_name !== "Agent" // Agent tool calls belong to the parent
  ) {
    const mainAgent = getMainAgent(sid, machine.id);
    if (mainAgent && mainAgent.id === agent_id) {
      const workingSubs = getWorkingSubagents(sid, machine.id);
      if (workingSubs.length > 0) {
        // Route to the most recently created working subagent
        effectiveAgentId = workingSubs[workingSubs.length - 1].id;
      }
    }
  }

  // --- Handle agent status transitions based on event type ---
  if (event_type === "tool_call") {
    // Agent is working on a tool
    const updated = updateAgent(effectiveAgentId, { status: "working", current_tool: tool_name || null }, machine.id);
    if (updated) broadcastEvent({ type: "agent_updated", data: updated });
  } else if (event_type === "tool_result") {
    // Tool finished — agent still working but clear current_tool
    const updated = updateAgent(effectiveAgentId, { status: "working", current_tool: null }, machine.id);
    if (updated) broadcastEvent({ type: "agent_updated", data: updated });
  } else if (event_type === "stop") {
    // Agent stopped (waiting for input or done)
    const updated = updateAgent(effectiveAgentId, { status: "idle", current_tool: null }, machine.id);
    if (updated) broadcastEvent({ type: "agent_updated", data: updated });
  } else if (event_type === "subagent_start") {
    // A subagent was spawned — create a child agent record
    // Parse subagent info from summary
    let subType = "agent";
    let subDesc = summary || "";
    if (typeof content === "string") {
      try {
        const toolInput = JSON.parse(content);
        subType = toolInput.subagent_type || "agent";
        subDesc = toolInput.description || toolInput.prompt?.substring(0, 100) || subDesc;
      } catch { /* use defaults */ }
    }

    const subagentId = `${agent_id}:sub:${Date.now()}`;
    const subagent = createAgent({
      id: subagentId,
      session_id: sid,
      parent_agent_id: agent_id,
      type: "subagent",
      subagent_type: subType,
      description: subDesc,
      status: "working",
      current_tool: null,
      started_at: Date.now(),
      ended_at: null,
      metadata: JSON.stringify({ subagent_type: subType }),
    }, machine.id);
    broadcastEvent({ type: "agent_created", data: subagent });
  } else if (event_type === "subagent_stop") {
    // A subagent finished — find and complete the most recent working subagent
    const workingSubs = getWorkingSubagents(sid, machine.id);
    if (workingSubs.length > 0) {
      const sub = workingSubs[workingSubs.length - 1]; // most recent
      const updated = updateAgent(sub.id, { status: "completed", ended_at: Date.now(), current_tool: null }, machine.id);
      if (updated) broadcastEvent({ type: "agent_updated", data: updated });
    }
  }

  // --- Record the event ---
  const event = createEvent({
    agent_id: effectiveAgentId,
    session_id: sid,
    event_type: event_type as AgentEvent["event_type"],
    tool_name: tool_name || null,
    summary: summary || null,
    content: content || null,
    files_affected: Array.isArray(files_affected) ? JSON.stringify(files_affected) : (files_affected || null),
    timestamp: ts,
  }, provider, sourceId, machine.id);

  // A racing duplicate (two retries in flight at once) loses the OR IGNORE and
  // must not be broadcast or counted as accepted.
  if (!event.inserted && sourceId !== null) {
    return { event: null, duplicate: true };
  }

  broadcastEvent({ type: "event_created", data: event });
  return { event, duplicate: false };
}
