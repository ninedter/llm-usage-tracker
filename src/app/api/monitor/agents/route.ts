import { NextRequest, NextResponse } from "next/server";
import { createAgent, listAgents } from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse, AgentRecord } from "@/types";

// POST /api/monitor/agents — Register a new agent
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<AgentRecord>>> {
  try {
    const body = await req.json();
    const { id, session_id, parent_agent_id, type, subagent_type, description, metadata } = body;

    if (!id || !session_id || !type) {
      return NextResponse.json(
        { success: false, error: { code: "INVALID_INPUT", message: "id, session_id, and type are required" } },
        { status: 400 }
      );
    }

    const agent = createAgent({
      id,
      session_id,
      parent_agent_id: parent_agent_id || null,
      type,
      subagent_type: subagent_type || null,
      description: description || "",
      status: "working",
      current_tool: null,
      started_at: Date.now(),
      ended_at: null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });

    broadcastEvent({ type: "agent_created", data: agent });

    return NextResponse.json({ success: true, data: agent }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "CREATE_ERROR", message: error instanceof Error ? error.message : "Failed to create agent" } },
      { status: 500 }
    );
  }
}

// GET /api/monitor/agents — List agents with optional filters
export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<AgentRecord[]>>> {
  try {
    const url = new URL(req.url);
    const session_id = url.searchParams.get("session_id") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const type = url.searchParams.get("type") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "100");
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const agents = listAgents({ session_id, status, type, limit, offset });
    return NextResponse.json({ success: true, data: agents });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "LIST_ERROR", message: error instanceof Error ? error.message : "Failed to list agents" } },
      { status: 500 }
    );
  }
}
