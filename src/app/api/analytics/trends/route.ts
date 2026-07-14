import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsTrends, rollupDailyUsageRange } from "@/lib/db";
import { readProvider } from "@/lib/provider-param";
import type { ApiResponse, TrendPoint } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<TrendPoint[]>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));
    const range = to - from;
    const granularity = range <= 2 * 86400000 ? "hourly" : "daily";

    rollupDailyUsageRange(from, to);

    const data = getAnalyticsTrends(from, to, granularity, provider);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get trends" } },
      { status: 500 }
    );
  }
}
