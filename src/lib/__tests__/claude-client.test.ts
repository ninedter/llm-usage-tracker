import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeClient } from "@/lib/providers/claude-client";

const planMetadata = ClaudeClient as unknown as { oauthPlanType: string | null };

beforeEach(() => {
  ClaudeClient.invalidateTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ClaudeClient.invalidateTokenCache();
});

describe("ClaudeClient subscription-aware usage", () => {
  it("labels OAuth usage from the matching cached account without an organization request", async () => {
    vi.spyOn(ClaudeClient, "readClaudeCodeOAuthToken").mockReturnValue("fake-oauth-token");
    planMetadata.oauthPlanType = "Ultra";
    vi.spyOn(ClaudeClient, "fetchOAuthUsage").mockResolvedValue({
      five_hour: null, seven_day: { utilization: 61 },
    });
    const organizations = vi.spyOn(ClaudeClient, "fetchOrganizations");
    const data = await new ClaudeClient("fake-session-key", "org-oauth").fetchUsage();
    expect(data.planType).toBe("Ultra");
    expect(data.session).toBeNull();
    expect(data.weekly?.percentage).toBe(61);
    expect(organizations).not.toHaveBeenCalled();
  });

  it("uses the session account's plan on OAuth fallback and caches its metadata", async () => {
    vi.spyOn(ClaudeClient, "readClaudeCodeOAuthToken").mockReturnValue("fake-oauth-token");
    planMetadata.oauthPlanType = "Ultra";
    vi.spyOn(ClaudeClient, "fetchOAuthUsage").mockRejectedValue(new Error("OAuth expired"));
    const organizations = vi.spyOn(ClaudeClient, "fetchOrganizations").mockResolvedValue([
      { uuid: "another-org", name: "Another account", planType: "Ultra" },
      { uuid: "org-fallback", name: "Session account", planType: "Pro" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
    })));
    for (let i = 0; i < 2; i++) {
      const data = await new ClaudeClient("fake-session-key", "org-fallback").fetchUsage();
      expect(data.planType).toBe("Pro");
      expect(data.session?.percentage).toBe(10);
    }
    expect(organizations).toHaveBeenCalledTimes(1);
    expect(organizations).toHaveBeenCalledWith("fake-session-key", expect.any(AbortSignal));
  });

  it("still returns usage when optional subscription metadata cannot be loaded", async () => {
    vi.spyOn(ClaudeClient, "readClaudeCodeOAuthToken").mockReturnValue(null);
    vi.spyOn(ClaudeClient, "fetchOrganizations").mockRejectedValue(new Error("Metadata unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ seven_day: { utilization: 44 } })));
    const data = await new ClaudeClient("fake-session-key", "org-metadata-error").fetchUsage();
    expect(data.planType).toBeNull();
    expect(data.session).toBeNull();
    expect(data.weekly?.percentage).toBe(44);
  });

  it("normalizes legacy organization tiers without losing the organization identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { uuid: "org-ultra", name: "Personal", billing_type: "max", rate_limit_tier: "default_claude_max_20x" },
      { uuid: "org-unknown", name: "Other" },
    ])));
    expect(await ClaudeClient.fetchOrganizations("fake-session-key")).toEqual([
      { uuid: "org-ultra", name: "Personal", planType: "Ultra" },
      { uuid: "org-unknown", name: "Other", planType: null },
    ]);
  });
});
