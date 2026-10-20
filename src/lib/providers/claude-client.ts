import { execFile } from "child_process";
import { userInfo } from "os";
import { promisify } from "util";
import type { ClaudeUsageData } from "@/types";
import { UPSTREAM_TIMEOUT_MS } from "../constants";
import {
  parseClaudeUsage,
  type ClaudePrepaidRaw,
  type ClaudeSpendLimitRaw,
  type ClaudeUsageResponse,
} from "./claude-parse";
import { CLAUDE_OAUTH_EXPIRED_MESSAGE, UpstreamAuthError } from "./errors";

const execFileAsync = promisify(execFile);

const OAUTH_USER_AGENT = () => process.env.CLAUDE_CODE_USER_AGENT || "claude-code/2.0.32";
const WEB_USER_AGENT = () =>
  process.env.CLAUDE_WEB_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function makeHeaders(sessionKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": WEB_USER_AGENT(),
    Referer: "https://claude.ai/",
    Origin: "https://claude.ai",
    Cookie: `sessionKey=${sessionKey}`,
  };
}

const timeoutSignal = () => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

/** Keychain probe result: `expired` means signed in once, but the token lapsed. */
export interface ClaudeOAuthState {
  token: string | null;
  expired: boolean;
}

export interface ClaudeSessionCreds {
  sessionKey: string;
  organizationId: string;
}

export class ClaudeClient {
  constructor(private session: ClaudeSessionCreds | null) {}

  static async fetchOrganizations(
    sessionKey: string
  ): Promise<Array<{ uuid: string; name: string }>> {
    const res = await fetch("https://claude.ai/api/organizations", {
      headers: makeHeaders(sessionKey),
      signal: timeoutSignal(),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new UpstreamAuthError(
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
   * Returns the access token or null if not found / expired.
   */
  static async readClaudeCodeOAuthToken(): Promise<string | null> {
    return (await ClaudeClient.readClaudeCodeOAuthState()).token;
  }

  /**
   * Keychain probe that tells "never signed in" apart from "sign-in expired",
   * so an expired token surfaces as AUTH_EXPIRED instead of looking unconfigured.
   *
   * Memoized: `security` hits the Keychain — doing that on every 60s usage
   * poll (and every health check) is wasteful. An absent token caches for the
   * full TTL so a machine without Claude Code isn't re-probed per request; an
   * expired one only for TOKEN_RETRY_TTL_MS so a fresh `claude` sign-in is
   * picked up within a minute; a valid one never outlives its own expiresAt.
   * Concurrent callers during a probe share one in-flight `execFile`.
   */
  private static tokenCache: { state: ClaudeOAuthState; until: number } | null = null;
  private static tokenInFlight: Promise<ClaudeOAuthState> | null = null;
  private static readonly TOKEN_TTL_MS = 5 * 60 * 1000;
  private static readonly TOKEN_RETRY_TTL_MS = 60_000;

  static async readClaudeCodeOAuthState(): Promise<ClaudeOAuthState> {
    const cached = ClaudeClient.tokenCache;
    if (cached && Date.now() < cached.until) return cached.state;
    if (ClaudeClient.tokenInFlight) return ClaudeClient.tokenInFlight;

    const probe: Promise<ClaudeOAuthState> = ClaudeClient.readTokenUncached().then(
      ({ expiresAt, ...state }) => {
        // invalidateTokenCache() during the probe detaches it: don't resurrect a stale value
        if (ClaudeClient.tokenInFlight === probe) {
          const now = Date.now();
          let until = now + (state.expired ? ClaudeClient.TOKEN_RETRY_TTL_MS : ClaudeClient.TOKEN_TTL_MS);
          if (expiresAt != null) until = Math.min(until, expiresAt);
          ClaudeClient.tokenCache = { state, until };
          ClaudeClient.tokenInFlight = null;
        }
        return state;
      }
    );
    ClaudeClient.tokenInFlight = probe;
    return probe;
  }

  /**
   * Drop the cached token entirely (e.g. immediately after the user saves
   * new credentials) so the very next read re-probes right away.
   */
  static invalidateTokenCache(): void {
    ClaudeClient.tokenCache = null;
    ClaudeClient.tokenInFlight = null;
  }

  /**
   * After an OAuth auth failure, don't drop the cached token outright — that
   * would re-spawn the Keychain probe on every poll while auth stays broken.
   * Keep the cached value but shorten its remaining life to TOKEN_RETRY_TTL_MS
   * so the next probe happens in at most a minute.
   */
  static markTokenSuspect(): void {
    const c = ClaudeClient.tokenCache;
    if (!c) return;
    const retryUntil = Date.now() + ClaudeClient.TOKEN_RETRY_TTL_MS;
    if (c.until > retryUntil) ClaudeClient.tokenCache = { state: c.state, until: retryUntil };
  }

  private static async readTokenUncached(): Promise<ClaudeOAuthState & { expiresAt?: number }> {
    const absent = { token: null, expired: false };
    try {
      if (process.platform !== "darwin") return absent;

      const username = userInfo().username;
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", username, "-w"],
        { timeout: 3000 }
      );

      const creds = JSON.parse(String(stdout).trim());
      const oauth = creds?.claudeAiOauth;
      const token = oauth?.accessToken;
      if (typeof token !== "string" || !token.startsWith("sk-ant-oat")) return absent;
      const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
      // An expired token only produces a 401 and a pointless fallback round-trip
      if (expiresAt != null && expiresAt < Date.now()) return { token: null, expired: true };
      return { token, expired: false, expiresAt };
    } catch {
      return absent;
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
        "User-Agent": OAUTH_USER_AGENT(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: timeoutSignal(),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new UpstreamAuthError(`OAuth usage API returned ${res.status}`);
      }
      throw new Error(`OAuth usage API returned ${res.status}`);
    }

    return res.json();
  }

  async fetchUsage(): Promise<ClaudeUsageData> {
    const { token: oauthToken, expired } = await ClaudeClient.readClaudeCodeOAuthState();
    if (!oauthToken && !this.session) {
      if (expired) throw new UpstreamAuthError(CLAUDE_OAUTH_EXPIRED_MESSAGE);
      throw new Error(
        "No Claude credentials: save a claude.ai session key in Settings or sign in to Claude Code."
      );
    }

    // Credit endpoints are session-only and best-effort; start them alongside usage
    const extrasPromise = this.session
      ? this.fetchExtras(this.session)
      : Promise.resolve({ prepaid: null, spendLimit: null });

    const usage = await this.fetchUsageBody(oauthToken);
    const extras = await extrasPromise;
    return parseClaudeUsage(usage, extras);
  }

  private async fetchUsageBody(oauthToken: string | null): Promise<ClaudeUsageResponse> {
    if (!oauthToken) return this.fetchSessionUsage(this.session!);

    try {
      return await ClaudeClient.fetchOAuthUsage(oauthToken);
    } catch (err) {
      // Only a rejected credential makes the token suspect. Don't invalidate
      // outright — that would re-spawn the Keychain probe on every poll while
      // auth stays broken; shorten its life so the next probe is within a minute.
      if (err instanceof UpstreamAuthError) ClaudeClient.markTokenSuspect();
      if (!this.session) throw err;
      return this.fetchSessionUsage(this.session);
    }
  }

  private async fetchSessionUsage(session: ClaudeSessionCreds): Promise<ClaudeUsageResponse> {
    const usageRes = await fetch(
      `https://claude.ai/api/organizations/${session.organizationId}/usage`,
      { headers: makeHeaders(session.sessionKey), signal: timeoutSignal() }
    );

    if (!usageRes.ok) {
      const status = usageRes.status;
      const body = await usageRes.text().catch(() => "");
      if (status === 401 || status === 403) {
        throw new UpstreamAuthError(
          `Session key expired or invalid. Please update it in Settings. (${status})`
        );
      }
      throw new Error(`Claude API error: ${status}. ${body.slice(0, 200)}`);
    }

    return usageRes.json();
  }

  private async fetchExtras(
    session: ClaudeSessionCreds
  ): Promise<{ prepaid: ClaudePrepaidRaw | null; spendLimit: ClaudeSpendLimitRaw | null }> {
    const [prepaid, spendLimit] = await Promise.all([
      this.fetchOptionalJson<ClaudePrepaidRaw>(session, "prepaid/credits"),
      this.fetchOptionalJson<ClaudeSpendLimitRaw>(session, "overage_spend_limit"),
    ]);
    return { prepaid, spendLimit };
  }

  /** Best-effort GET: any failure (network, timeout, non-2xx, bad JSON) is null. */
  private async fetchOptionalJson<T>(
    session: ClaudeSessionCreds,
    path: string
  ): Promise<T | null> {
    try {
      const res = await fetch(
        `https://claude.ai/api/organizations/${session.organizationId}/${path}`,
        { headers: makeHeaders(session.sessionKey), signal: timeoutSignal() }
      );
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
