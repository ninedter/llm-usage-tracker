import { NextResponse } from "next/server";
import {
  getClaudeUsage,
  getOpenAIUsage,
  type UsageResult,
} from "@/lib/providers/usage-service";
import type { ApiResponse, ProviderHealth, ProviderHealthEntry } from "@/types";

function toEntry<T>(result: UsageResult<T>): ProviderHealthEntry {
  if (result.ok) return { configured: true, connected: true };
  return {
    configured: result.code !== "MISSING_CREDENTIALS",
    connected: false,
    error: result.message,
    code: result.code,
  };
}

export async function GET(): Promise<
  NextResponse<ApiResponse<ProviderHealth>>
> {
  // Parallel upstream checks sharing the 30s usage cache that the usage
  // routes populate, so a healthy dashboard poll adds no extra round-trips.
  const [claude, openai] = await Promise.all([getClaudeUsage(), getOpenAIUsage()]);
  return NextResponse.json({
    success: true,
    data: { claude: toEntry(claude), openai: toEntry(openai) },
  });
}
