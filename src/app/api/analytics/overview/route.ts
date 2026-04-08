import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsOverview, rollupDailyUsage } from "@/lib/db";
import type { ApiResponse, AnalyticsOverview } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<AnalyticsOverview>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    rollupDailyUsage();

    const data = getAnalyticsOverview(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get overview" } },
      { status: 500 }
    );
  }
}
