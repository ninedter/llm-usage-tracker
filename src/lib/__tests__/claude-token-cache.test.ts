import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeClient } from "@/lib/providers/claude-client";

/**
 * ClaudeClient.markTokenSuspect() only rewrites in-memory static cache state
 * (it never shells out to `security`), so it's testable by poking that state
 * directly through a type cast — no child_process mock, no real Keychain
 * access. This intentionally never calls readClaudeCodeOAuthToken()/
 * readTokenUncached(), which are the only methods that touch the subprocess.
 */
type ClaudeClientInternals = {
  tokenCache: { value: string | null; at: number } | null;
  readonly TOKEN_TTL_MS: number;
  readonly TOKEN_RETRY_TTL_MS: number;
};
const Internal = ClaudeClient as unknown as ClaudeClientInternals;

describe("ClaudeClient.markTokenSuspect", () => {
  beforeEach(() => {
    ClaudeClient.invalidateTokenCache();
  });

  afterEach(() => {
    ClaudeClient.invalidateTokenCache();
    vi.useRealTimers();
  });

  it("is a no-op when nothing is cached", () => {
    expect(Internal.tokenCache).toBeNull();
    ClaudeClient.markTokenSuspect();
    expect(Internal.tokenCache).toBeNull();
  });

  it("keeps the cached value but shortens its remaining life to TOKEN_RETRY_TTL_MS", () => {
    vi.useFakeTimers();
    const now = Date.now();
    Internal.tokenCache = { value: "sk-ant-oat-fake-token", at: now };

    ClaudeClient.markTokenSuspect();

    const after = Internal.tokenCache;
    expect(after).not.toBeNull();
    // The value survives — no Keychain re-probe happens right away.
    expect(after?.value).toBe("sk-ant-oat-fake-token");
    // Remaining life = (at + TOKEN_TTL_MS) - now must now equal TOKEN_RETRY_TTL_MS,
    // i.e. the next readClaudeCodeOAuthToken() re-probe is <= 1 minute away
    // instead of up to 5 minutes away.
    const remainingMs = after!.at + Internal.TOKEN_TTL_MS - now;
    expect(remainingMs).toBe(Internal.TOKEN_RETRY_TTL_MS);
  });

  it("does not extend the life of an entry that already expires sooner than TOKEN_RETRY_TTL_MS", () => {
    vi.useFakeTimers();
    const now = Date.now();
    // Stamped so only 10s of life remains — already shorter than the 60s retry window.
    const at = now - Internal.TOKEN_TTL_MS + 10_000;
    Internal.tokenCache = { value: "sk-ant-oat-fake-token", at };

    ClaudeClient.markTokenSuspect();

    expect(Internal.tokenCache).toEqual({ value: "sk-ant-oat-fake-token", at });
  });
});
