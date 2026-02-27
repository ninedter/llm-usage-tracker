import { NextResponse } from "next/server";
import { getCredentials } from "@/lib/credentials";
import { ClaudeClient } from "@/lib/providers/claude-client";
import type { ApiResponse, ProviderHealth } from "@/types";

export async function GET(): Promise<
  NextResponse<ApiResponse<ProviderHealth>>
> {
  const creds = getCredentials();
  const health: ProviderHealth = {
    claude: { connected: false },
  };

  if (creds.claude?.sessionKey && creds.claude?.organizationId) {
    try {
      await new ClaudeClient(creds.claude.sessionKey, creds.claude.organizationId).fetchUsage();
      health.claude.connected = true;
    } catch (e) {
      health.claude.error = e instanceof Error ? e.message : "Unknown error";
    }
  } else {
    health.claude.error = "No credentials configured";
  }

  return NextResponse.json({ success: true, data: health });
}
