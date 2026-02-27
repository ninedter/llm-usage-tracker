import { NextResponse } from "next/server";
import { ClaudeClient } from "@/lib/providers/claude-client";
import type { ApiResponse } from "@/types";

interface Org {
  uuid: string;
  name: string;
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResponse<Org[]>>> {
  try {
    const { sessionKey } = await request.json();
    if (!sessionKey) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "MISSING_KEY",
            message: "Session key is required.",
          },
        },
        { status: 400 }
      );
    }

    const orgs = await ClaudeClient.fetchOrganizations(sessionKey);
    return NextResponse.json({ success: true, data: orgs });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "FETCH_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch organizations",
        },
      },
      { status: 500 }
    );
  }
}
