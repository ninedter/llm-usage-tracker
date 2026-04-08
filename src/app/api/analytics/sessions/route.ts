import { NextRequest, NextResponse } from "next/server";
import { getSessionAnalytics } from "@/lib/db";
import type { ApiResponse, SessionAnalyticRow } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<SessionAnalyticRow[]>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));
    const sort = url.searchParams.get("sort") || "started_at";
    const order = url.searchParams.get("order") || "desc";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const data = getSessionAnalytics(from, to, sort, order, limit, offset);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get sessions" } },
      { status: 500 }
    );
  }
}
