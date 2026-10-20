import { describe, it, expect } from "vitest";
import { claudeCreditSummary, openaiCreditSummary } from "@/lib/usage/credits";
import type {
  ClaudeExtraUsage,
  ClaudeUsageData,
  OpenAICredits,
  OpenAIUsageData,
  UsageWindow,
} from "@/types";

const win: UsageWindow = {
  tokensUsed: 0,
  tokenLimit: 0,
  percentage: 0,
  resetTime: null,
  level: "safe",
};

const extra = (over: Partial<ClaudeExtraUsage>): ClaudeExtraUsage => ({
  enabled: true,
  currency: "USD",
  monthlyLimit: null,
  used: 0,
  remaining: null,
  percentage: null,
  level: "safe",
  outOfCredits: false,
  ...over,
});

const claude = (over: Partial<ClaudeUsageData>): ClaudeUsageData => ({
  session: win,
  weekly: win,
  modelBreakdown: [],
  extraUsage: null,
  prepaidBalance: null,
  lastUpdated: "",
  ...over,
});

const openai = (
  credits: OpenAICredits | null,
  creditsDepleted = false
): OpenAIUsageData => ({
  planType: "Plus",
  windows: [],
  featureLimits: [],
  resetCreditsAvailable: null,
  resetCredits: [],
  credits,
  creditsDepleted,
  lastUpdated: "",
});

describe("claudeCreditSummary", () => {
  it("prefers the prepaid balance", () => {
    const d = claude({
      prepaidBalance: { amount: 12.34, currency: "USD" },
      extraUsage: extra({ monthlyLimit: 50, used: 17.2, remaining: 32.8 }),
    });
    expect(claudeCreditSummary(d)).toBe("$12.34 left");
  });

  it("shows remaining extra usage when capped", () => {
    const d = claude({
      extraUsage: extra({ monthlyLimit: 50, used: 17.2, remaining: 32.8 }),
    });
    expect(claudeCreditSummary(d)).toBe("$32.80 left");
  });

  it("shows spend when extra usage is enabled without a cap", () => {
    const d = claude({ extraUsage: extra({ used: 2.77 }) });
    expect(claudeCreditSummary(d)).toBe("$2.77 spent");
  });

  it("returns null when extra usage is disabled and there is no prepaid balance", () => {
    const d = claude({ extraUsage: extra({ enabled: false }) });
    expect(claudeCreditSummary(d)).toBeNull();
  });

  it("returns null when there is no credit data at all", () => {
    expect(claudeCreditSummary(claude({}))).toBeNull();
  });
});

describe("openaiCreditSummary", () => {
  it("reports unlimited credits", () => {
    expect(
      openaiCreditSummary(openai({ hasCredits: true, unlimited: true, balance: null }))
    ).toBe("Unlimited");
  });

  it("reports a numeric balance", () => {
    expect(
      openaiCreditSummary(openai({ hasCredits: true, unlimited: false, balance: 240 }))
    ).toBe("240 credits");
  });

  it("reports availability when there is no balance figure", () => {
    expect(
      openaiCreditSummary(openai({ hasCredits: true, unlimited: false, balance: null }))
    ).toBe("Credits available");
  });

  it("reports depletion", () => {
    expect(
      openaiCreditSummary(
        openai({ hasCredits: false, unlimited: false, balance: null }, true)
      )
    ).toBe("Credits depleted");
  });

  it("returns null when there is no credits object", () => {
    expect(openaiCreditSummary(openai(null))).toBeNull();
  });
});
