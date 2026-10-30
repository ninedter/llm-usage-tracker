import { execSync } from "child_process";
import { userInfo } from "os";
import type { ClaudeUsageData } from "@/types";
import { claudePlanName, parseClaudeUsage, type ClaudeUsageResponse } from "./claude-usage";
import { ttlCache } from "../ttl-cache";
import { createHash } from "crypto";

const sessionPlanCache = ttlCache<string | null>(5 * 60_000);

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

export class ClaudeClient {
  constructor(
    private sessionKey: string,
    private organizationId: string
  ) {}

  static async fetchOrganizations(
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<Array<{ uuid: string; name: string; planType: string | null }>> {
    const res = await fetch("https://claude.ai/api/organizations", {
      headers: makeHeaders(sessionKey),
      signal,
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

    return orgs.map((o: { uuid: string; name: string; billing_type?: string; rate_limit_tier?: string }) => ({
      uuid: o.uuid,
      name: o.name,
      planType: claudePlanName(o.billing_type, o.rate_limit_tier),
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
  private static oauthPlanType: string | null = null;
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
    ClaudeClient.oauthPlanType = null;
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
    ClaudeClient.oauthPlanType = null;
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
        ClaudeClient.oauthPlanType = claudePlanName(
          creds.claudeAiOauth.subscriptionType,
          creds.claudeAiOauth.rateLimitTier,
        );
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
  static async fetchOAuthUsage(oauthToken: string): Promise<ClaudeUsageResponse> {
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
    let usage: ClaudeUsageResponse;
    let planType: string | null;

    // Try OAuth token first (more reliable, covers all clients)
    const oauthToken = ClaudeClient.readClaudeCodeOAuthToken();
    if (oauthToken) {
      const oauthPlanType = ClaudeClient.oauthPlanType;
      try {
        usage = await ClaudeClient.fetchOAuthUsage(oauthToken);
        planType = oauthPlanType;
      } catch {
        // Token may be stale/revoked. Don't invalidate outright — that would
        // re-spawn the Keychain probe on every poll while auth stays broken.
        // Mark it suspect so the next probe happens within a minute instead
        // of waiting out the full 5min TTL.
        ClaudeClient.markTokenSuspect();
        // Fall back to session key
        usage = await this.fetchSessionUsage();
        planType = await this.fetchSessionPlan();
      }
    } else {
      usage = await this.fetchSessionUsage();
      planType = await this.fetchSessionPlan();
    }

    return parseClaudeUsage(usage, planType);
  }

  private async fetchSessionPlan(): Promise<string | null> {
    // Never attach the local OAuth account's plan to a session-key fallback:
    // they may represent different accounts. Plan labels are best-effort and
    // must not prevent usage from loading if organization metadata fails.
    const key = createHash("sha256").update(JSON.stringify([this.sessionKey, this.organizationId])).digest("hex");
    try {
      return await sessionPlanCache.get(key, async () => {
        const organizations = await ClaudeClient.fetchOrganizations(this.sessionKey, AbortSignal.timeout(3000));
        return organizations.find((o) => o.uuid === this.organizationId)?.planType ?? null;
      });
    } catch {
      return null;
    }
  }

  private async fetchSessionUsage(): Promise<ClaudeUsageResponse> {
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
}
