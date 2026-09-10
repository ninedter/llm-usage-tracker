import { NextResponse } from "next/server";
import { listMachines } from "@/lib/db";
import type { ApiResponse, MachineSummary } from "@/types";

/**
 * GET /api/machines — every machine the hub has heard from, newest first.
 *
 * Unauthenticated on purpose: this feeds the browser UI's machine filter, the
 * UI itself has no auth today, and the hub is only reachable over the tailnet.
 * It exposes machine ids and labels, never event content. If the UI ever grows
 * a session, this should adopt it rather than invent its own.
 */
export async function GET(): Promise<NextResponse<ApiResponse<MachineSummary[]>>> {
  try {
    return NextResponse.json({ success: true, data: listMachines() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "LIST_ERROR", message: error instanceof Error ? error.message : "Failed to list machines" } },
      { status: 500 }
    );
  }
}
