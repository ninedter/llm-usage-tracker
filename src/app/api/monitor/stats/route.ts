import { NextRequest, NextResponse } from "next/server";
import { getMonitorStats, abandonStaleSessions, archiveStaleAgents, runRetentionIfDue } from "@/lib/db";
import { readProvider } from "@/lib/provider-param";
import type { ApiResponse, MonitorStats } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<MonitorStats>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);

    // Clean up stale sessions periodically (runs every ~30s via SWR refresh).
    // These sweeps stay global — retiring a finished agent isn't something the
    // user's current provider tab should gate.
    abandonStaleSessions();
    archiveStaleAgents();
    try { runRetentionIfDue(Date.now()); } catch (e) { console.error("[retention] auto-purge failed:", e); }

    const stats = getMonitorStats(provider);
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "STATS_ERROR", message: error instanceof Error ? error.message : "Failed to get stats" } },
      { status: 500 }
    );
  }
}
