import { NextResponse } from "next/server";
import { OpenAIClient } from "@/lib/providers/openai-client";
import type { ApiResponse, OpenAIUsageData } from "@/types";

export async function GET(): Promise<
  NextResponse<ApiResponse<OpenAIUsageData>>
> {
  try {
    const auth = OpenAIClient.readCodexAuth();
    if (!auth) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "MISSING_CREDENTIALS",
            message:
              "Codex CLI login not found (~/.codex/auth.json). Run `codex login` to connect your ChatGPT account.",
          },
        },
        { status: 401 }
      );
    }

    const client = new OpenAIClient(auth.accessToken, auth.accountId);
    const data = await client.fetchUsage();

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
              : "Failed to fetch OpenAI usage",
        },
      },
      { status: 500 }
    );
  }
}
