import { NextRequest, NextResponse } from "next/server";
import { listEvents } from "@/lib/db";
import type { ApiResponse, AgentEvent } from "@/types";

// GET /api/monitor/events/:agentId — Get events for an agent
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse<ApiResponse<AgentEvent[]>>> {
  try {
    const { agentId } = await params;
    const url = new URL(req.url);
    const event_type = url.searchParams.get("event_type") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "500");
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const order = (url.searchParams.get("order") === "desc" ? "desc" : "asc") as "asc" | "desc";

    const events = listEvents(agentId, { event_type, limit, offset, order });
    return NextResponse.json({ success: true, data: events });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch events" } },
      { status: 500 }
    );
  }
}
