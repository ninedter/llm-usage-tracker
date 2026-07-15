import { NextResponse } from "next/server";
import { getCredentials } from "@/lib/credentials";
import { ClaudeClient } from "@/lib/providers/claude-client";
import { OpenAIClient } from "@/lib/providers/openai-client";
import { claudeUsageCache, openaiUsageCache } from "@/lib/providers/usage-cache";
import type { ApiResponse, ProviderHealth } from "@/types";

export async function GET(): Promise<
  NextResponse<ApiResponse<ProviderHealth>>
> {
  const creds = getCredentials();
  const health: ProviderHealth = {
    claude: { connected: false },
    openai: { connected: false },
  };

  // Parallelize the two upstream checks (previously serial, ~1.43s) and reuse
  // the same 30s-TTL cache the usage routes populate, so a healthy dashboard
  // poll doesn't force a second round-trip to either SaaS.
  const [claudeResult, openaiResult] = await Promise.allSettled([
    (async () => {
      const sessionKey = creds.claude?.sessionKey;
      const organizationId = creds.claude?.organizationId;
      if (!sessionKey || !organizationId) throw new Error("No credentials configured");
      await claudeUsageCache.get("claude", () =>
        new ClaudeClient(sessionKey, organizationId).fetchUsage()
      );
    })(),
    (async () => {
      const codexAuth = OpenAIClient.readCodexAuth();
      if (!codexAuth) throw new Error("Codex CLI not logged in");
      await openaiUsageCache.get("openai", () =>
        new OpenAIClient(codexAuth.accessToken, codexAuth.accountId).fetchUsage()
      );
    })(),
  ]);
  health.claude.connected = claudeResult.status === "fulfilled";
  if (claudeResult.status === "rejected") health.claude.error = claudeResult.reason instanceof Error ? claudeResult.reason.message : "Unknown error";
  health.openai.connected = openaiResult.status === "fulfilled";
  if (openaiResult.status === "rejected") health.openai.error = openaiResult.reason instanceof Error ? openaiResult.reason.message : "Unknown error";

  return NextResponse.json({ success: true, data: health });
}
