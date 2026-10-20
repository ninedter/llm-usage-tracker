import { NextResponse } from "next/server";
import {
  getClaudeUsage,
  getOpenAIUsage,
  type UsageResult,
} from "@/lib/providers/usage-service";
import { CLAUDE_SESSION_KEY_EXPIRED_HINT } from "@/lib/constants";
import type {
  ApiResponse,
  ClaudeUsageData,
  ProviderHealth,
  ProviderHealthEntry,
} from "@/types";

function toEntry<T>(result: UsageResult<T>, warning?: (data: T) => string | undefined): ProviderHealthEntry {
  if (result.ok) {
    const w = warning?.(result.data);
    return w ? { configured: true, connected: true, warning: w } : { configured: true, connected: true };
  }
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
    data: { claude: toEntry(claude, claudeWarning), openai: toEntry(openai) },
  });
}

const claudeWarning = (d: ClaudeUsageData) =>
  d.sessionKeyExpired ? CLAUDE_SESSION_KEY_EXPIRED_HINT : undefined;
