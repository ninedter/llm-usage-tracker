import { NextResponse } from "next/server";
import { getStorageInfo } from "@/lib/db";
import type { ApiResponse, StorageInfo } from "@/types";

export const dynamic = "force-dynamic";

// GET /api/monitor/storage — DB size, per-table counts, session time range
export async function GET(): Promise<NextResponse<ApiResponse<StorageInfo>>> {
  try {
    return NextResponse.json({ success: true, data: getStorageInfo() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "STORAGE_ERROR", message: error instanceof Error ? error.message : "Failed to read storage info" } },
      { status: 500 }
    );
  }
}
