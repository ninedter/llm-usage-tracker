import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import type { ApiResponse, RetentionPolicy } from "@/types";

export const dynamic = "force-dynamic";

function readPolicy(): RetentionPolicy {
  const last = parseInt(getSetting("last_purge_at") || "0", 10);
  return {
    enabled: getSetting("retention_enabled") === "1",
    days: parseInt(getSetting("retention_days") || "30", 10),
    last_purge_at: last > 0 ? last : null,
  };
}

// GET /api/monitor/retention — current policy
export async function GET(): Promise<NextResponse<ApiResponse<RetentionPolicy>>> {
  try {
    return NextResponse.json({ success: true, data: readPolicy() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "RETENTION_ERROR", message: error instanceof Error ? error.message : "Failed to read retention policy" } },
      { status: 500 }
    );
  }
}

// PUT /api/monitor/retention — { enabled?, days? }
export async function PUT(req: NextRequest): Promise<NextResponse<ApiResponse<RetentionPolicy>>> {
  try {
    const body = (await req.json().catch(() => ({}))) || {};
    if (typeof body.enabled === "boolean") setSetting("retention_enabled", body.enabled ? "1" : "0");
    if (typeof body.days === "number" && Number.isInteger(body.days) && body.days > 0) setSetting("retention_days", String(body.days));
    return NextResponse.json({ success: true, data: readPolicy() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "RETENTION_ERROR", message: error instanceof Error ? error.message : "Failed to update retention policy" } },
      { status: 500 }
    );
  }
}
