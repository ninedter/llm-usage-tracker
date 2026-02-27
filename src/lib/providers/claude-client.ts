import { execSync } from "child_process";
import type { ClaudeUsageData } from "@/types";
import { getUsageLevel } from "../constants";

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://claude.ai/",
  Origin: "https://claude.ai",
};

function makeHeaders(sessionKey: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    Cookie: `sessionKey=${sessionKey}`,
  };
}

// Response from claude.ai/api/organizations/{orgId}/usage
// AND api.anthropic.com/api/oauth/usage
interface UsageBucket {
  utilization?: number; // 0-100
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: UsageBucket;
  seven_day?: UsageBucket;
  seven_day_opus?: UsageBucket;
  seven_day_sonnet?: UsageBucket;
  seven_day_oauth_apps?: UsageBucket | null;
  // Legacy field names (kept for backwards compat)
  session_usage_percent?: number;
  weekly_usage_percent?: number;
}

export class ClaudeClient {
  constructor(
    private sessionKey: string,
    private organizationId: string
  ) {}

  static async fetchOrganizations(
    sessionKey: string
  ): Promise<Array<{ uuid: string; name: string }>> {
    const res = await fetch("https://claude.ai/api/organizations", {
      headers: makeHeaders(sessionKey),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Session key is expired or invalid (${res.status}). ${body ? "Response: " + body.slice(0, 200) : ""}`
        );
      }
      throw new Error(
        `Failed to fetch organizations: ${res.status} ${res.statusText}. ${body ? body.slice(0, 200) : ""}`
      );
    }

    const orgs = await res.json();
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("No organizations found for this session key.");
    }

    return orgs.map((o: { uuid: string; name: string }) => ({
      uuid: o.uuid,
      name: o.name,
    }));
  }

  /**
   * Try to read Claude Code's OAuth token from the macOS Keychain.
   * Returns the access token or null if not found.
   */
  static readClaudeCodeOAuthToken(): string | null {
    try {
      if (process.platform !== "darwin") return null;

      const username = execSync("whoami", { encoding: "utf-8" }).trim();
      const raw = execSync(
        `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();

      const creds = JSON.parse(raw);
      const token = creds?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token.startsWith("sk-ant-oat")) {
        return token;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch usage from the OAuth endpoint (covers web + desktop + code).
   */
  static async fetchOAuthUsage(oauthToken: string): Promise<UsageResponse> {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.0.32",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`OAuth usage API returned ${res.status}`);
    }

    return res.json();
  }

  async fetchUsage(): Promise<ClaudeUsageData> {
    let usage: UsageResponse;

    // Try OAuth token first (more reliable, covers all clients)
    const oauthToken = ClaudeClient.readClaudeCodeOAuthToken();
    if (oauthToken) {
      try {
        usage = await ClaudeClient.fetchOAuthUsage(oauthToken);
      } catch {
        // Fall back to session key
        usage = await this.fetchSessionUsage();
      }
    } else {
      usage = await this.fetchSessionUsage();
    }

    return this.parseUsageResponse(usage);
  }

  private async fetchSessionUsage(): Promise<UsageResponse> {
    const headers = makeHeaders(this.sessionKey);

    const usageRes = await fetch(
      `https://claude.ai/api/organizations/${this.organizationId}/usage`,
      { headers }
    );

    if (!usageRes.ok) {
      const status = usageRes.status;
      const body = await usageRes.text().catch(() => "");
      if (status === 401 || status === 403) {
        throw new Error(
          `Session key expired or invalid. Please update it in Settings. (${status})`
        );
      }
      throw new Error(`Claude API error: ${status}. ${body.slice(0, 200)}`);
    }

    return usageRes.json();
  }

  private parseUsageResponse(usage: UsageResponse): ClaudeUsageData {
    // New format: five_hour.utilization (0-100), seven_day.utilization (0-100)
    const fiveHourUtil = usage.five_hour?.utilization ?? 0;
    const sevenDayUtil = usage.seven_day?.utilization ?? 0;
    const fiveHourReset = usage.five_hour?.resets_at ?? null;
    const sevenDayReset = usage.seven_day?.resets_at ?? null;

    // Legacy format fallback
    const sessionPct =
      fiveHourUtil > 0
        ? fiveHourUtil
        : (usage.session_usage_percent ?? 0) * 100;
    const weeklyPct =
      sevenDayUtil > 0
        ? sevenDayUtil
        : (usage.weekly_usage_percent ?? 0) * 100;

    // Per-model breakdown from seven_day_* buckets
    const modelBreakdown: ClaudeUsageData["modelBreakdown"] = [];

    if (usage.seven_day_opus?.utilization != null) {
      const opusUtil = usage.seven_day_opus.utilization;
      modelBreakdown.push({
        modelId: "opus",
        modelName: "Opus",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: opusUtil,
        level: getUsageLevel(opusUtil),
      });
    }

    if (usage.seven_day_sonnet?.utilization != null) {
      const sonnetUtil = usage.seven_day_sonnet.utilization;
      modelBreakdown.push({
        modelId: "sonnet",
        modelName: "Sonnet",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: sonnetUtil,
        level: getUsageLevel(sonnetUtil),
      });
    }

    return {
      session: {
        tokensUsed: 0,
        tokenLimit: 0,
        percentage: sessionPct,
        resetTime: fiveHourReset,
        level: getUsageLevel(sessionPct),
      },
      weekly: {
        tokensUsed: 0,
        tokenLimit: 0,
        percentage: weeklyPct,
        resetTime: sevenDayReset,
        level: getUsageLevel(weeklyPct),
      },
      modelBreakdown,
      lastUpdated: new Date().toISOString(),
    };
  }
}
