import { NextResponse } from "next/server";
import { getCredentials } from "@/lib/credentials";
import { ClaudeClient } from "@/lib/providers/claude-client";
import { OpenAIClient } from "@/lib/providers/openai-client";
import type { ApiResponse, ProviderHealth } from "@/types";

export async function GET(): Promise<
  NextResponse<ApiResponse<ProviderHealth>>
> {
  const creds = getCredentials();
  const health: ProviderHealth = {
    claude: { connected: false },
    openai: { connected: false },
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

  const codexAuth = OpenAIClient.readCodexAuth();
  if (codexAuth) {
    try {
      await new OpenAIClient(codexAuth.accessToken, codexAuth.accountId).fetchUsage();
      health.openai.connected = true;
    } catch (e) {
      health.openai.error = e instanceof Error ? e.message : "Unknown error";
    }
  } else {
    health.openai.error = "Codex CLI not logged in";
  }

  return NextResponse.json({ success: true, data: health });
}
