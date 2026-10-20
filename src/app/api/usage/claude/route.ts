import { NextResponse } from "next/server";
import { getClaudeUsage } from "@/lib/providers/usage-service";
import type { ApiResponse, ClaudeUsageData } from "@/types";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResponse<ClaudeUsageData>>> {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const result = await getClaudeUsage({ fresh });
  if (result.ok) return NextResponse.json({ success: true, data: result.data });
  return NextResponse.json(
    { success: false, error: { code: result.code, message: result.message } },
    { status: result.status }
  );
}
