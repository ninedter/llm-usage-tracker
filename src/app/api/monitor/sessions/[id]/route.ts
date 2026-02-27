import { NextRequest, NextResponse } from "next/server";
import { getSessionAgents } from "@/lib/db";
import type { ApiResponse, AgentRecord } from "@/types";

// GET /api/monitor/sessions/:id — Get all agents in a session
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResponse<AgentRecord[]>>> {
  try {
    const { id } = await params;
    const agents = getSessionAgents(id);
    return NextResponse.json({ success: true, data: agents });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch session" } },
      { status: 500 }
    );
  }
}
