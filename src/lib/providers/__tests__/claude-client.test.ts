import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => {
  // Real execFile exposes a custom promisify returning { stdout, stderr }
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => execMock(...args),
  });
  return { execFile, default: { execFile } };
});

import { ClaudeClient } from "../claude-client";
import { UpstreamAuthError } from "../errors";

const OAUTH_TOKEN = "sk-ant-oat01-test";
const keychain = (oauth: Record<string, unknown>) =>
  Promise.resolve({ stdout: JSON.stringify({ claudeAiOauth: oauth }) + "\n", stderr: "" });

const USAGE = { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 34, resets_at: null } };
const SESSION = { sessionKey: "sk-session", organizationId: "org-1" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let fetchMock: ReturnType<typeof vi.fn>;
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  ClaudeClient.invalidateTokenCache();
  execMock.mockReset();
  Object.defineProperty(process, "platform", { value: "darwin" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  vi.unstubAllGlobals();
  ClaudeClient.invalidateTokenCache();
});

describe("ClaudeClient.fetchUsage", () => {
  it("OAuth-only: no session -> no claude.ai calls, prepaidBalance null", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockResolvedValue(json(USAGE));

    const data = await new ClaudeClient(null).fetchUsage();

    expect(urls()).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
    expect(urls().some((u) => u.includes("claude.ai"))).toBe(false);
    expect(data.prepaidBalance).toBeNull();
  });

  it("session creds: prepaid + spend limit merged", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/prepaid/credits")) return json({ amount: 500, currency: "USD" });
      if (url.endsWith("/overage_spend_limit"))
        return json({ is_enabled: true, monthly_credit_limit: 10000, used_credits: 2500, currency: "USD" });
      return json(USAGE);
    });

    const data = await new ClaudeClient(SESSION).fetchUsage();

    expect(data.prepaidBalance).toEqual({ amount: 5, currency: "USD" });
    expect(data.extraUsage).toMatchObject({ enabled: true, monthlyLimit: 100, used: 25 });
  });

  it.each([
    ["500", () => json({}, 500)],
    ["throws", () => Promise.reject(new Error("boom"))],
  ])("prepaid endpoint %s -> usage still resolves with prepaidBalance null", async (_n, failure) => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/prepaid/credits")) return failure();
      if (url.endsWith("/overage_spend_limit")) return json({}, 404);
      return json(USAGE);
    });

    const data = await new ClaudeClient(SESSION).fetchUsage();
    expect(data.prepaidBalance).toBeNull();
  });

  it("session usage 401 -> rejects with UpstreamAuthError", async () => {
    execMock.mockRejectedValue(new Error("no keychain item"));
    fetchMock.mockResolvedValue(json({}, 401));

    await expect(new ClaudeClient(SESSION).fetchUsage()).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  it("no token and no session -> rejects with 'No Claude credentials'", async () => {
    execMock.mockRejectedValue(new Error("no keychain item"));

    await expect(new ClaudeClient(null).fetchUsage()).rejects.toThrow(/No Claude credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("every fetch call receives an AbortSignal", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/prepaid/credits") ? json({ amount: 1 }) : json(USAGE)
    );

    await new ClaudeClient(SESSION).fetchUsage();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("OAuth auth failure falls back to session and marks the token suspect", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.anthropic.com")) return json({}, 401);
      if (url.endsWith("/prepaid/credits") || url.endsWith("/overage_spend_limit")) return json({}, 404);
      return json(USAGE);
    });
    const suspect = vi.spyOn(ClaudeClient, "markTokenSuspect");

    const data = await new ClaudeClient(SESSION).fetchUsage();

    expect(data.session.percentage).toBe(12);
    expect(urls()).toContain("https://claude.ai/api/organizations/org-1/usage");
    expect(suspect).toHaveBeenCalledTimes(1);
    suspect.mockRestore();
  });

  it("non-auth OAuth failure falls back without marking the token suspect", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.anthropic.com")) return json({}, 500);
      if (url.endsWith("/prepaid/credits") || url.endsWith("/overage_spend_limit")) return json({}, 404);
      return json(USAGE);
    });
    const suspect = vi.spyOn(ClaudeClient, "markTokenSuspect");

    await new ClaudeClient(SESSION).fetchUsage();

    expect(suspect).not.toHaveBeenCalled();
    suspect.mockRestore();
  });

  it("expired Keychain token and no session -> UpstreamAuthError naming the re-sign-in step", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN, expiresAt: Date.now() - 1000 }));

    const err = await new ClaudeClient(null).fetchUsage().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect(err.message).toMatch(/sign-in expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OAuth failure without a session rethrows the OAuth error", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    fetchMock.mockResolvedValue(json({}, 401));

    await expect(new ClaudeClient(null).fetchUsage()).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe("ClaudeClient.readClaudeCodeOAuthToken", () => {
  it("expired expiresAt -> resolves null", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN, expiresAt: Date.now() - 1000 }));
    await expect(ClaudeClient.readClaudeCodeOAuthToken()).resolves.toBeNull();
  });

  it("expired expiresAt -> state reports expired (not absent)", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN, expiresAt: Date.now() - 1000 }));
    await expect(ClaudeClient.readClaudeCodeOAuthState()).resolves.toEqual({
      token: null,
      expired: true,
    });
  });

  it("absent Keychain item -> state reports neither token nor expired", async () => {
    execMock.mockRejectedValue(new Error("no keychain item"));
    await expect(ClaudeClient.readClaudeCodeOAuthState()).resolves.toEqual({
      token: null,
      expired: false,
    });
  });

  it("an expired result is cached only for the short retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      execMock.mockImplementation(() =>
        keychain({ accessToken: OAUTH_TOKEN, expiresAt: Date.now() - 1000 })
      );
      await ClaudeClient.readClaudeCodeOAuthState();
      vi.advanceTimersByTime(59_000);
      await ClaudeClient.readClaudeCodeOAuthState();
      expect(execMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      await ClaudeClient.readClaudeCodeOAuthState();
      expect(execMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cached valid token is not served past its own expiresAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const expiresAt = Date.now() + 30_000;
      execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN, expiresAt }));
      await expect(ClaudeClient.readClaudeCodeOAuthToken()).resolves.toBe(OAUTH_TOKEN);

      vi.advanceTimersByTime(31_000);
      // Re-probes instead of serving the cached (now expired) token for the full TTL
      await expect(ClaudeClient.readClaudeCodeOAuthState()).resolves.toEqual({
        token: null,
        expired: true,
      });
      expect(execMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("future expiresAt -> resolves the token", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN, expiresAt: Date.now() + 60_000 }));
    await expect(ClaudeClient.readClaudeCodeOAuthToken()).resolves.toBe(OAUTH_TOKEN);
  });

  it("concurrent callers share one probe, and the result is memoized", async () => {
    execMock.mockReturnValue(keychain({ accessToken: OAUTH_TOKEN }));
    const [a, b] = await Promise.all([
      ClaudeClient.readClaudeCodeOAuthToken(),
      ClaudeClient.readClaudeCodeOAuthToken(),
    ]);
    await ClaudeClient.readClaudeCodeOAuthToken();

    expect(a).toBe(OAUTH_TOKEN);
    expect(b).toBe(OAUTH_TOKEN);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("non-darwin never probes the Keychain", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(ClaudeClient.readClaudeCodeOAuthToken()).resolves.toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });
});
