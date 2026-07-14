import { NextResponse } from "next/server";
import { getMonitorStats, abandonStaleSessions, archiveStaleAgents, runRetentionIfDue } from "@/lib/db";
import type { ApiResponse, MonitorStats } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<ApiResponse<MonitorStats>>> {
  try {
    // Clean up stale sessions periodically (runs every ~30s via SWR refresh)
    abandonStaleSessions();
    archiveStaleAgents();
    try { runRetentionIfDue(Date.now()); } catch (e) { console.error("[retention] auto-purge failed:", e); }
    const stats = getMonitorStats();
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "STATS_ERROR", message: error instanceof Error ? error.message : "Failed to get stats" } },
      { status: 500 }
    );
  }
}
