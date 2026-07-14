import { NextRequest, NextResponse } from "next/server";
import { previewPurge, purgeOlderThan, purgeEverything } from "@/lib/db";
import { broadcastEvent } from "@/lib/ws";
import type { ApiResponse, PurgeCounts, PurgeResult } from "@/types";

export const dynamic = "force-dynamic";

// Positive int → that many days; omitted / 0 / "all" → full wipe.
function parseDays(param: string | number | null | undefined): number | "all" {
  if (param === null || param === undefined || param === "all") return "all";
  const n = typeof param === "number" ? param : parseInt(param, 10);
  if (!Number.isFinite(n) || n <= 0) return "all";
  return Math.floor(n);
}

// GET /api/monitor/purge?days=N — dry-run preview
export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<{ cutoff_ms: number; would_delete: PurgeCounts }>>> {
  try {
    const days = parseDays(req.nextUrl.searchParams.get("days"));
    const cutoff = days === "all" ? Date.now() : Date.now() - days * 86400000;
    return NextResponse.json({ success: true, data: { cutoff_ms: cutoff, would_delete: previewPurge(cutoff) } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "PURGE_PREVIEW_ERROR", message: error instanceof Error ? error.message : "Failed to preview purge" } },
      { status: 500 }
    );
  }
}

// POST /api/monitor/purge — { days } — execute (with VACUUM).
// "Everything" must be an explicit choice, never a parse-failure default:
// require days to be a positive integer or the literal "all".
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<PurgeResult>>> {
  try {
    const body = await req.json().catch(() => null);
    const raw = body?.days;
    const isAll = raw === "all";
    const isDays = typeof raw === "number" && Number.isInteger(raw) && raw > 0;
    if (!isAll && !isDays) {
      return NextResponse.json(
        { success: false, error: { code: "PURGE_BAD_REQUEST", message: 'POST body must include "days" as a positive integer or "all".' } },
        { status: 400 }
      );
    }
    const result = isAll
      ? purgeEverything({ vacuum: true })
      : purgeOlderThan(Date.now() - (raw as number) * 86400000, { vacuum: true });
    broadcastEvent({ type: "stats_updated", data: result });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "PURGE_ERROR", message: error instanceof Error ? error.message : "Failed to purge data" } },
      { status: 500 }
    );
  }
}
