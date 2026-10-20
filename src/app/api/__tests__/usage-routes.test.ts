import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({
  claudeFetch: vi.fn(),
  openaiFetch: vi.fn(),
  readState: vi.fn(),
  readCodexAuth: vi.fn(),
  claudeCtor: vi.fn(),
}));

vi.mock("@/lib/providers/claude-client", () => ({
  ClaudeClient: class {
    constructor(session: unknown) {
      mocks.claudeCtor(session);
    }
    fetchUsage() {
      return mocks.claudeFetch();
    }
    static async readClaudeCodeOAuthState() {
      return mocks.readState();
    }
    static async readClaudeCodeOAuthToken() {
      return (await mocks.readState()).token;
    }
    static invalidateTokenCache() {}
  },
}));
vi.mock("@/lib/providers/openai-client", () => ({
  OpenAIClient: class {
    fetchUsage() {
      return mocks.openaiFetch();
    }
    static readCodexAuth() {
      return mocks.readCodexAuth();
    }
  },
}));

let claudeRoute: typeof import("@/app/api/usage/claude/route");
let openaiRoute: typeof import("@/app/api/usage/openai/route");
let healthRoute: typeof import("@/app/api/health/route");
let caches: typeof import("@/lib/providers/usage-cache");
let creds: typeof import("@/lib/credentials");
let UpstreamAuthError: typeof import("@/lib/providers/errors").UpstreamAuthError;

beforeAll(async () => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "usage-routes-"));
  claudeRoute = await import("@/app/api/usage/claude/route");
  openaiRoute = await import("@/app/api/usage/openai/route");
  healthRoute = await import("@/app/api/health/route");
  caches = await import("@/lib/providers/usage-cache");
  creds = await import("@/lib/credentials");
  ({ UpstreamAuthError } = await import("@/lib/providers/errors"));
});

const CLAUDE_DATA = { plan: "max", extraUsage: null };
const OPENAI_DATA = { plan: "plus", credits: { hasCredits: true, balance: 12.5 } };

beforeEach(() => {
  vi.clearAllMocks();
  caches.claudeUsageCache.invalidate("claude");
  caches.openaiUsageCache.invalidate("openai");
  mocks.readState.mockResolvedValue({ token: "oauth-token", expired: false });
  mocks.readCodexAuth.mockReturnValue({ accessToken: "t", accountId: "a" });
  mocks.claudeFetch.mockResolvedValue(CLAUDE_DATA);
  mocks.openaiFetch.mockResolvedValue(OPENAI_DATA);
});

const NO_TOKEN = { token: null, expired: false };
const EXPIRED_TOKEN = { token: null, expired: true };

const req = (path: string) => new Request(`http://localhost${path}`);

describe("GET /api/usage/claude", () => {
  it("caches without ?fresh=1 and refetches with it", async () => {
    await claudeRoute.GET(req("/api/usage/claude"));
    await claudeRoute.GET(req("/api/usage/claude"));
    expect(mocks.claudeFetch).toHaveBeenCalledTimes(1);

    await claudeRoute.GET(req("/api/usage/claude?fresh=1"));
    expect(mocks.claudeFetch).toHaveBeenCalledTimes(2);
  });

  it("returns data on success", async () => {
    const res = await claudeRoute.GET(req("/api/usage/claude"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: CLAUDE_DATA });
  });

  it("401 MISSING_CREDENTIALS when no session and no OAuth token", async () => {
    mocks.readState.mockResolvedValue(NO_TOKEN);
    const res = await claudeRoute.GET(req("/api/usage/claude"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("MISSING_CREDENTIALS");
    expect(mocks.claudeFetch).not.toHaveBeenCalled();
  });

  it("401 AUTH_EXPIRED (not MISSING_CREDENTIALS) when the Keychain token expired and no session key", async () => {
    mocks.readState.mockResolvedValue(EXPIRED_TOKEN);
    const res = await claudeRoute.GET(req("/api/usage/claude"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("AUTH_EXPIRED");
    expect(json.error.message).toMatch(/Claude Code sign-in expired/);
    expect(mocks.claudeFetch).not.toHaveBeenCalled();
  });

  it("401 AUTH_EXPIRED when upstream rejects credentials", async () => {
    mocks.claudeFetch.mockRejectedValue(new UpstreamAuthError("expired"));
    const res = await claudeRoute.GET(req("/api/usage/claude"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({ code: "AUTH_EXPIRED", message: "expired" });
  });

  it("502 FETCH_ERROR on other failures", async () => {
    mocks.claudeFetch.mockRejectedValue(new Error("boom"));
    const res = await claudeRoute.GET(req("/api/usage/claude"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toEqual({ code: "FETCH_ERROR", message: "boom" });
  });
});

describe("GET /api/usage/openai", () => {
  it("returns credits from the client", async () => {
    const res = await openaiRoute.GET(req("/api/usage/openai"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.credits).toEqual({ hasCredits: true, balance: 12.5 });
  });

  it("401 MISSING_CREDENTIALS when Codex login is absent", async () => {
    mocks.readCodexAuth.mockReturnValue(null);
    const res = await openaiRoute.GET(req("/api/usage/openai"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("MISSING_CREDENTIALS");
  });

  it("?fresh=1 bypasses the cache", async () => {
    await openaiRoute.GET(req("/api/usage/openai"));
    await openaiRoute.GET(req("/api/usage/openai?fresh=1"));
    expect(mocks.openaiFetch).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/health", () => {
  it("reports configured + connected when both succeed", async () => {
    const json = await (await healthRoute.GET()).json();
    expect(json.data.claude).toEqual({ configured: true, connected: true });
    expect(json.data.openai).toEqual({ configured: true, connected: true });
  });

  it("connected Claude with an expired session key carries a warning", async () => {
    mocks.claudeFetch.mockResolvedValue({ ...CLAUDE_DATA, sessionKeyExpired: true });
    const json = await (await healthRoute.GET()).json();
    expect(json.data.claude).toMatchObject({ configured: true, connected: true });
    expect(json.data.claude.warning).toMatch(/session key expired/);
  });

  it("reports AUTH_EXPIRED as configured but disconnected", async () => {
    mocks.claudeFetch.mockRejectedValue(new UpstreamAuthError("expired"));
    const json = await (await healthRoute.GET()).json();
    expect(json.data.claude).toMatchObject({
      configured: true,
      connected: false,
      code: "AUTH_EXPIRED",
    });
  });

  it("an expired Keychain token with no session key is configured but disconnected", async () => {
    mocks.readState.mockResolvedValue(EXPIRED_TOKEN);
    const json = await (await healthRoute.GET()).json();
    expect(json.data.claude).toMatchObject({
      configured: true,
      connected: false,
      code: "AUTH_EXPIRED",
    });
  });

  it("reports unconfigured providers", async () => {
    mocks.readState.mockResolvedValue(NO_TOKEN);
    mocks.readCodexAuth.mockReturnValue(null);
    const json = await (await healthRoute.GET()).json();
    expect(json.data.claude).toMatchObject({ configured: false, connected: false, code: "MISSING_CREDENTIALS" });
    expect(json.data.openai).toMatchObject({ configured: false, connected: false, code: "MISSING_CREDENTIALS" });
  });

  it("treats saved session creds as configured without an OAuth token", async () => {
    mocks.readState.mockResolvedValue(NO_TOKEN);
    creds.saveCredentials({ claude: { sessionKey: "sk", organizationId: "org" } });
    try {
      const json = await (await healthRoute.GET()).json();
      expect(json.data.claude).toMatchObject({ configured: true, connected: true });
      expect(mocks.claudeCtor).toHaveBeenCalledWith({ sessionKey: "sk", organizationId: "org" });
    } finally {
      creds.deleteCredentials("claude");
    }
  });
});

describe("credentials memo", () => {
  it("returns saved credentials and isolates callers from the cache", () => {
    const x = { claude: { sessionKey: "abc", organizationId: "org" } };
    creds.saveCredentials(x);
    const a = creds.getCredentials();
    expect(a).toEqual(x);
    a.claude!.sessionKey = "mutated";
    expect(creds.getCredentials().claude!.sessionKey).toBe("abc");
    creds.deleteCredentials("claude");
    expect(creds.getCredentials()).toEqual({});
  });
});
