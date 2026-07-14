import { NextRequest, NextResponse } from "next/server";
import { getUsageInsights } from "@/lib/db";
import { readProvider } from "@/lib/provider-param";
import type { ApiResponse, UsageInsights } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<UsageInsights>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    const data = getUsageInsights(from, to, provider);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get insights" } },
      { status: 500 }
    );
  }
}
