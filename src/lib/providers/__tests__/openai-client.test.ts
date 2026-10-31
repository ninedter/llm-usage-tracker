import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIClient } from "../openai-client";
import { UpstreamAuthError } from "../errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIClient.fetchUsage", () => {
  it("401 -> UpstreamAuthError", async () => {
    fetchMock.mockResolvedValue(json({}, 401));
    await expect(new OpenAIClient("tok", "acct").fetchUsage()).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  it("reset-credits failure is tolerated", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/rate-limit-reset-credits") ? json({}, 500) : json({ plan_type: "plus" })
    );
    await expect(new OpenAIClient("tok", "acct").fetchUsage()).resolves.toBeDefined();
  });

  it("every fetch call receives an AbortSignal", async () => {
    fetchMock.mockResolvedValue(json({}));
    await new OpenAIClient("tok", "acct").fetchUsage();
    expect(fetchMock.mock.calls.length).toBe(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });
});
