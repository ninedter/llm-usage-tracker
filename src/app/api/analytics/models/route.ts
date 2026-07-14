import { NextRequest, NextResponse } from "next/server";
import { getModelAnalytics, rollupDailyUsageRange } from "@/lib/db";
import { readProvider } from "@/lib/provider-param";
import type { ApiResponse, ModelAnalytics } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<ModelAnalytics>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    rollupDailyUsageRange(from, to);

    const data = getModelAnalytics(from, to, provider);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get model analytics" } },
      { status: 500 }
    );
  }
}
