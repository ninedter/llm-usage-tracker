import { NextResponse } from "next/server";
import { getOpenAIUsage } from "@/lib/providers/usage-service";
import type { ApiResponse, OpenAIUsageData } from "@/types";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResponse<OpenAIUsageData>>> {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const result = await getOpenAIUsage({ fresh });
  if (result.ok) return NextResponse.json({ success: true, data: result.data });
  return NextResponse.json(
    { success: false, error: { code: result.code, message: result.message } },
    { status: result.status }
  );
}
