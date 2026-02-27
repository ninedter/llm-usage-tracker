import { NextRequest, NextResponse } from "next/server";
import { getAgent, updateAgent, getAgentChildren, listEvents } from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse, AgentWithEvents } from "@/types";

// GET /api/monitor/agents/:id — Get agent with events and children
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<AgentWithEvents>>> {
  try {
    const { id } = await params;
    const agent = getAgent(id);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Agent not found" } },
        { status: 404 }
      );
    }

    const events = listEvents(id);
    const children = getAgentChildren(id);

    return NextResponse.json({
      success: true,
      data: { ...agent, events, children },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch agent" } },
      { status: 500 }
    );
  }
}

// PATCH /api/monitor/agents/:id — Update agent status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<import("@/types").AgentRecord>>> {
  try {
    const { id } = await params;
    const body = await req.json();
    const { status, description, metadata } = body;

    const updates: Parameters<typeof updateAgent>[1] = {};
    if (status) updates.status = status;
    if (description) updates.description = description;
    if (metadata) updates.metadata = JSON.stringify(metadata);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      updates.ended_at = Date.now();
    }

    const agent = updateAgent(id, updates);
    if (!agent) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Agent not found" } },
        { status: 404 }
      );
    }

    broadcastEvent({ type: "agent_updated", data: agent });

    return NextResponse.json({ success: true, data: agent });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "UPDATE_ERROR", message: error instanceof Error ? error.message : "Failed to update agent" } },
      { status: 500 }
    );
  }
}
