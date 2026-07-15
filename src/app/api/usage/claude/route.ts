import { NextResponse } from "next/server";
import { getCredentials } from "@/lib/credentials";
import { ClaudeClient } from "@/lib/providers/claude-client";
import { claudeUsageCache } from "@/lib/providers/usage-cache";
import type { ApiResponse, ClaudeUsageData } from "@/types";

export async function GET(): Promise<
  NextResponse<ApiResponse<ClaudeUsageData>>
> {
  try {
    const creds = getCredentials();
    if (!creds.claude?.sessionKey || !creds.claude?.organizationId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "MISSING_CREDENTIALS",
            message: "Claude session key and organization ID are required.",
          },
        },
        { status: 401 }
      );
    }

    const client = new ClaudeClient(
      creds.claude.sessionKey,
      creds.claude.organizationId
    );
    const data = await claudeUsageCache.get("claude", () => client.fetchUsage());

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "FETCH_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch Claude usage",
        },
      },
      { status: 500 }
    );
  }
}
