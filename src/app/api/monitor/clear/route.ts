import { NextResponse } from "next/server";
import { clearAllMonitorData } from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse } from "@/types";

// DELETE /api/monitor/clear — Clear all monitor data
export async function DELETE(): Promise<NextResponse<ApiResponse<{ sessions: number; agents: number; events: number; token_usage: number }>>> {
  try {
    const result = clearAllMonitorData();

    // Notify connected clients to refresh
    broadcastEvent({ type: "stats_updated", data: result });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "CLEAR_ERROR", message: error instanceof Error ? error.message : "Failed to clear data" } },
      { status: 500 }
    );
  }
}
