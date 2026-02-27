import { NextRequest, NextResponse } from "next/server";
import {
  createEvent,
  ensureAgent,
  ensureSession,
  updateAgent,
  updateSession,
  completeSessionAgents,
  createAgent,
  getMainAgent,
  getWorkingSubagents,
} from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse, AgentEvent } from "@/types";

// POST /api/monitor/events — Record a new event and handle lifecycle transitions
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<AgentEvent>>> {
  try {
    const body = await req.json();
    const {
      agent_id, session_id, event_type, tool_name, summary, content,
      files_affected, agent_project, agent_entrypoint, agent_cwd,
    } = body;

    if (!agent_id || !event_type) {
      return NextResponse.json(
        { success: false, error: { code: "INVALID_INPUT", message: "agent_id and event_type are required" } },
        { status: 400 }
      );
    }

    const sid = session_id || agent_id;

    // --- Handle session lifecycle events ---
    if (event_type === "session_start") {
      const session = ensureSession(sid, agent_project, agent_cwd, agent_entrypoint);
      broadcastEvent({ type: "session_created", data: session });

      // Also ensure the main agent exists
      const agent = ensureAgent(agent_id, sid, agent_project, agent_entrypoint);
      if (agent.created_at === agent.started_at) {
        broadcastEvent({ type: "agent_created", data: agent });
      }
    } else if (event_type === "session_end") {
      // Mark session completed
      const session = updateSession(sid, { status: "completed", ended_at: Date.now() });
      if (session) broadcastEvent({ type: "session_updated", data: session });

      // Complete all running agents in this session
      completeSessionAgents(sid);

      // Update the main agent status
      const mainAgent = getMainAgent(sid);
      if (mainAgent) {
        const updated = updateAgent(mainAgent.id, { status: "completed", ended_at: Date.now(), current_tool: null });
        if (updated) broadcastEvent({ type: "agent_updated", data: updated });
      }
    } else {
      // For all other events, ensure session and agent exist
      ensureSession(sid, agent_project, agent_cwd, agent_entrypoint);
      const agent = ensureAgent(agent_id, sid, agent_project, agent_entrypoint);
      if (agent.created_at === agent.started_at) {
        broadcastEvent({ type: "agent_created", data: agent });
      }
    }

    // --- Route events to the correct agent ---
    // When there are working subagents and the event came from the session's main agent,
    // attribute tool_call/tool_result/stop events to the most recent working subagent.
    let effectiveAgentId = agent_id;
    if (
      (event_type === "tool_call" || event_type === "tool_result" || event_type === "stop") &&
      tool_name !== "Agent" // Agent tool calls belong to the parent
    ) {
      const mainAgent = getMainAgent(sid);
      if (mainAgent && mainAgent.id === agent_id) {
        const workingSubs = getWorkingSubagents(sid);
        if (workingSubs.length > 0) {
          // Route to the most recently created working subagent
          effectiveAgentId = workingSubs[workingSubs.length - 1].id;
        }
      }
    }

    // --- Handle agent status transitions based on event type ---
    if (event_type === "tool_call") {
      // Agent is working on a tool
      const updated = updateAgent(effectiveAgentId, { status: "working", current_tool: tool_name || null });
      if (updated) broadcastEvent({ type: "agent_updated", data: updated });
    } else if (event_type === "tool_result") {
      // Tool finished — agent still working but clear current_tool
      const updated = updateAgent(effectiveAgentId, { status: "working", current_tool: null });
      if (updated) broadcastEvent({ type: "agent_updated", data: updated });
    } else if (event_type === "stop") {
      // Agent stopped (waiting for input or done)
      const updated = updateAgent(effectiveAgentId, { status: "idle", current_tool: null });
      if (updated) broadcastEvent({ type: "agent_updated", data: updated });
    } else if (event_type === "subagent_start") {
      // A subagent was spawned — create a child agent record
      // Parse subagent info from summary
      let subType = "agent";
      let subDesc = summary || "";
      if (typeof body.content === "string") {
        try {
          const toolInput = JSON.parse(body.content);
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
      });
      broadcastEvent({ type: "agent_created", data: subagent });
    } else if (event_type === "subagent_stop") {
      // A subagent finished — find and complete the most recent working subagent
      const workingSubs = getWorkingSubagents(sid);
      if (workingSubs.length > 0) {
        const sub = workingSubs[workingSubs.length - 1]; // most recent
        const updated = updateAgent(sub.id, { status: "completed", ended_at: Date.now(), current_tool: null });
        if (updated) broadcastEvent({ type: "agent_updated", data: updated });
      }
    }

    // --- Record the event ---
    const event = createEvent({
      agent_id: effectiveAgentId,
      session_id: sid,
      event_type,
      tool_name: tool_name || null,
      summary: summary || null,
      content: content || null,
      files_affected: Array.isArray(files_affected) ? JSON.stringify(files_affected) : (files_affected || null),
      timestamp: Date.now(),
    });

    broadcastEvent({ type: "event_created", data: event });

    return NextResponse.json({ success: true, data: event }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "CREATE_ERROR", message: error instanceof Error ? error.message : "Failed to create event" } },
      { status: 500 }
    );
  }
}
