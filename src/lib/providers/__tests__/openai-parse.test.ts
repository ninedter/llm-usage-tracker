import { describe, it, expect } from "vitest";
import { parseCredits, parseOpenAIUsage } from "../openai-parse";

describe("parseCredits", () => {
  it("parses a string balance", () => {
    expect(parseCredits({ has_credits: true, unlimited: false, balance: "9.99" })).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 9.99,
    });
  });

  it("parses a numeric balance", () => {
    expect(parseCredits({ has_credits: true, balance: 12 })).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 12,
    });
  });

  it.each(["0", "", "abc", null, "-3"])("maps balance %j to null", (balance) => {
    expect(parseCredits({ has_credits: true, unlimited: false, balance })).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: null,
    });
  });

  it("preserves hasCredits false", () => {
    expect(parseCredits({ has_credits: false, balance: "0" })).toMatchObject({
      hasCredits: false,
      balance: null,
    });
  });

  it("reports unlimited", () => {
    expect(parseCredits({ unlimited: true, has_credits: true })).toMatchObject({
      unlimited: true,
      hasCredits: true,
    });
  });

  it("returns null when credits object is absent", () => {
    expect(parseCredits(undefined)).toBeNull();
    expect(parseCredits(null)).toBeNull();
  });
});

describe("parseOpenAIUsage", () => {
  it("flags credits depleted from rate_limit_reached_type", () => {
    expect(
      parseOpenAIUsage({ rate_limit_reached_type: "workspace_member_credits_depleted" }, null)
        .creditsDepleted
    ).toBe(true);
    expect(parseOpenAIUsage({ rate_limit_reached_type: "primary" }, null).creditsDepleted).toBe(
      false
    );
    expect(parseOpenAIUsage({}, null).creditsDepleted).toBe(false);
  });

  it("handles object-shaped rate_limit_reached_type", () => {
    const depleted = parseOpenAIUsage(
      { rate_limit_reached_type: { type: "workspace_member_credits_depleted" } },
      null
    );
    expect(depleted.creditsDepleted).toBe(true);
    const reached = parseOpenAIUsage(
      { rate_limit_reached_type: { type: "rate_limit_reached", details: "default" } as never },
      null
    );
    expect(reached.creditsDepleted).toBe(false);
  });

  it.each([42, [], {}, { type: 5 }])("does not throw on garbage reached type %j", (v) => {
    const r = parseOpenAIUsage({ rate_limit_reached_type: v as never }, null);
    expect(r.creditsDepleted).toBe(false);
  });

  it("treats overage_limit_reached as depleted", () => {
    expect(
      parseOpenAIUsage({ credits: { has_credits: true, overage_limit_reached: true } }, null)
        .creditsDepleted
    ).toBe(true);
    expect(
      parseOpenAIUsage({ credits: { has_credits: true, overage_limit_reached: false } }, null)
        .creditsDepleted
    ).toBe(false);
  });

  it("parses the live credits shape", () => {
    const r = parseOpenAIUsage(
      {
        credits: {
          has_credits: true,
          unlimited: false,
          overage_limit_reached: false,
          balance: "60744.8007935000",
          approx_local_messages: [],
          approx_cloud_messages: [],
        } as never,
      },
      null
    );
    expect(r.credits).toMatchObject({ hasCredits: true, unlimited: false });
    expect(r.credits!.balance).toBeCloseTo(60744.8, 1);
    expect(r.creditsDepleted).toBe(false);
  });

  it("uses plain window labels for a nameless two-window feature limit", () => {
    const r = parseOpenAIUsage(
      {
        additional_rate_limits: [
          {
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 18000 },
              secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
            },
          },
        ],
      },
      null
    );
    expect(r.featureLimits.map((w) => w.label)).toEqual(["5-Hour Window", "7-Day Window"]);
  });

  it("includes parsed credits", () => {
    const r = parseOpenAIUsage({ credits: { has_credits: true, balance: "5" } }, null);
    expect(r.credits).toEqual({ hasCredits: true, unlimited: false, balance: 5 });
    expect(parseOpenAIUsage({}, null).credits).toBeNull();
  });

  it("emits primary and secondary windows for a feature limit", () => {
    const r = parseOpenAIUsage(
      {
        additional_rate_limits: [
          {
            limit_name: "GPT-5 Codex",
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 18000 },
              secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
            },
          },
        ],
      },
      null
    );
    expect(r.featureLimits.map((w) => w.label)).toEqual([
      "GPT-5 Codex · 5-Hour Window",
      "GPT-5 Codex · 7-Day Window",
    ]);
    expect(r.featureLimits.map((w) => w.percentage)).toEqual([10, 40]);
  });

  it("keeps the plain name for a single-window feature limit", () => {
    const r = parseOpenAIUsage(
      {
        additional_rate_limits: [
          {
            limit_name: "GPT-5 Codex",
            rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
          },
        ],
      },
      null
    );
    expect(r.featureLimits.map((w) => w.label)).toEqual(["GPT-5 Codex"]);
  });

  it("keeps plain name when only the secondary window exists", () => {
    const r = parseOpenAIUsage(
      {
        additional_rate_limits: [
          {
            limit_name: "Spark",
            rate_limit: { secondary_window: { used_percent: 5, limit_window_seconds: 604800 } },
          },
        ],
      },
      null
    );
    expect(r.featureLimits.map((w) => w.label)).toEqual(["Spark"]);
  });

  it("sorts main windows shortest-first, maps plan name, lists only available reset credits", () => {
    const r = parseOpenAIUsage(
      {
        plan_type: "prolite",
        rate_limit: {
          primary_window: { used_percent: 50, limit_window_seconds: 604800 },
          secondary_window: { used_percent: 20, limit_window_seconds: 18000 },
        },
      },
      {
        credits: [
          { id: "a", status: "available", title: "Reset" },
          { id: "b", status: "used" },
        ],
        available_count: 1,
      }
    );
    expect(r.planType).toBe("Pro Lite");
    expect(r.windows.map((w) => w.windowSeconds)).toEqual([18000, 604800]);
    expect(r.resetCredits).toEqual([{ id: "a", title: "Reset", expiresAt: null }]);
    expect(r.resetCreditsAvailable).toBe(1);
  });
});
