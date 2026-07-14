import { execSync } from "child_process";
import { userInfo } from "os";
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

// Modern per-limit entries. Per-model usage (e.g. Fable) only appears here,
// as weekly_scoped entries with scope.model — the seven_day_<model> buckets
// are null on current plans.
interface UsageLimit {
  kind?: string; // "session" | "weekly_all" | "weekly_scoped" | ...
  group?: string; // "session" | "weekly"
  percent?: number; // 0-100
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

interface UsageResponse {
  five_hour?: UsageBucket;
  seven_day?: UsageBucket;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  limits?: UsageLimit[] | null;
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
   *
   * Memoized for 5 minutes: `security` forks a subprocess and hits the
   * Keychain — doing that on every 60s usage poll (and every health check)
   * stalls the event loop for no benefit. A failed/absent token also caches
   * (as null) so a machine without Claude Code isn't re-probed per request.
   */
  private static tokenCache: { value: string | null; at: number } | null = null;
  private static readonly TOKEN_TTL_MS = 5 * 60 * 1000;
  private static readonly TOKEN_RETRY_TTL_MS = 60_000;

  static readClaudeCodeOAuthToken(): string | null {
    const cached = ClaudeClient.tokenCache;
    if (cached && Date.now() - cached.at < ClaudeClient.TOKEN_TTL_MS) return cached.value;
    const value = ClaudeClient.readTokenUncached();
    ClaudeClient.tokenCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Drop the cached token entirely (e.g. immediately after the user saves
   * new credentials) so the very next read re-probes right away.
   */
  static invalidateTokenCache(): void {
    ClaudeClient.tokenCache = null;
  }

  /**
   * After an OAuth failure, don't drop the cached token outright — that would
   * re-spawn the Keychain probe on every poll while auth stays broken. Keep
   * the cached value but shorten its remaining life to TOKEN_RETRY_TTL_MS so
   * the next probe happens in at most a minute.
   */
  static markTokenSuspect(): void {
    const c = ClaudeClient.tokenCache;
    if (!c) return;
    const retryAt = Date.now() - ClaudeClient.TOKEN_TTL_MS + ClaudeClient.TOKEN_RETRY_TTL_MS;
    if (c.at > retryAt) ClaudeClient.tokenCache = { value: c.value, at: retryAt };
  }

  private static readTokenUncached(): string | null {
    try {
      if (process.platform !== "darwin") return null;

      const username = userInfo().username;
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
        // Token may be stale/revoked. Don't invalidate outright — that would
        // re-spawn the Keychain probe on every poll while auth stays broken.
        // Mark it suspect so the next probe happens within a minute instead
        // of waiting out the full 5min TTL.
        ClaudeClient.markTokenSuspect();
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

    // Per-model breakdown from scoped limits entries (e.g. Fable, Opus).
    // The scoped percent shares the weekly window, so it renders alongside
    // the 7-day bar the same way the old seven_day_* buckets did.
    const modelBreakdown: ClaudeUsageData["modelBreakdown"] = [];

    for (const limit of usage.limits ?? []) {
      const modelName = limit.scope?.model?.display_name;
      if (modelName && limit.percent != null) {
        modelBreakdown.push({
          modelId: modelName.toLowerCase(),
          modelName,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          utilization: limit.percent,
          level: getUsageLevel(limit.percent),
        });
      }
    }

    // Legacy seven_day_* buckets (null on current plans)
    if (modelBreakdown.length === 0) {
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
