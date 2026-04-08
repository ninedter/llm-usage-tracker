import { NextRequest, NextResponse } from "next/server";
import { getToolAnalytics } from "@/lib/db";
import type { ApiResponse, ToolAnalytics } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<ToolAnalytics>>> {
  try {
    const url = new URL(req.url);
    const now = Date.now();
    const from = parseInt(url.searchParams.get("from") || String(now - 7 * 86400000));
    const to = parseInt(url.searchParams.get("to") || String(now));

    const data = getToolAnalytics(from, to);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "ANALYTICS_ERROR", message: error instanceof Error ? error.message : "Failed to get tool analytics" } },
      { status: 500 }
    );
  }
}
