import { NextResponse } from "next/server";
import { listSessions } from "@/lib/db";
import type { ApiResponse, AgentSession } from "@/types";

// GET /api/monitor/sessions — List all sessions
export async function GET(): Promise<NextResponse<ApiResponse<AgentSession[]>>> {
  try {
    const sessions = listSessions();
    return NextResponse.json({ success: true, data: sessions });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch sessions" } },
      { status: 500 }
    );
  }
}
