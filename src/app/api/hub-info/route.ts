import { NextResponse } from "next/server";
import { getHubUrl } from "@/lib/hub";
import type { ApiResponse, HubInfo } from "@/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/hub-info — the hub's configured public URL, read at request time.
 *
 * Unauthenticated, like `/api/machines`: it returns a hostname the caller
 * already had to resolve to get here, and the UI has no session of its own.
 * Exists because `NEXT_PUBLIC_HUB_URL` is inlined into the client bundle at
 * build time — Settings needs the value the *container* was started with.
 */
export async function GET(): Promise<NextResponse<ApiResponse<HubInfo>>> {
  return NextResponse.json({ success: true, data: { hub_url: getHubUrl() } });
}
