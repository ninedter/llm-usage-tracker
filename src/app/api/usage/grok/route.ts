import { NextResponse } from "next/server";
import { getGrokUsage } from "@/lib/providers/usage-service";
import type { ApiResponse, GrokUsageData } from "@/types";

export async function GET(): Promise<NextResponse<ApiResponse<GrokUsageData>>> {
  const result = await getGrokUsage();
  if (result.ok) return NextResponse.json({ success: true, data: result.data });
  return NextResponse.json(
    { success: false, error: { code: result.code, message: result.message } },
    { status: result.status }
  );
}
