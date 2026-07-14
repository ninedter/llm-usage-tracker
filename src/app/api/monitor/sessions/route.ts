import { NextRequest, NextResponse } from "next/server";
import { listSessions } from "@/lib/db";
import { readProvider } from "@/lib/provider-param";
import type { ApiResponse, AgentSession } from "@/types";

// GET /api/monitor/sessions — List all sessions (optionally one provider)
export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<AgentSession[]>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);

    const sessions = listSessions(50, provider);
    return NextResponse.json({ success: true, data: sessions });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch sessions" } },
      { status: 500 }
    );
  }
}
