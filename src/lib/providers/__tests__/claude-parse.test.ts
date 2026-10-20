import { describe, it, expect } from "vitest";
import { parseClaudeUsage, parseExtraUsage, parsePrepaid } from "../claude-parse";

describe("parseExtraUsage", () => {
  it("parses extra usage in cents", () => {
    const r = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1720.0,
      utilization: 34.4,
      currency: "usd",
    });
    expect(r).toMatchObject({
      enabled: true,
      currency: "USD",
      monthlyLimit: 50,
      used: 17.2,
      percentage: 34.4,
      level: "safe",
      outOfCredits: false,
    });
    expect(r!.remaining).toBeCloseTo(32.8, 2);
  });

  it("derives percentage when utilization is null", () => {
    const r = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 1500,
      utilization: null,
    });
    expect(r!.percentage).toBe(75);
    expect(r!.level).toBe("moderate");
  });

  it("handles no monthly cap", () => {
    const r = parseExtraUsage({ is_enabled: true, used_credits: 277, currency: "CAD" });
    expect(r).toMatchObject({
      monthlyLimit: null,
      remaining: null,
      percentage: null,
      used: 2.77,
      currency: "CAD",
      level: "safe",
    });
  });

  it("fills gaps from spend limit and reads out_of_credits", () => {
    const r = parseExtraUsage(undefined, {
      is_enabled: true,
      monthly_credit_limit: 10000,
      used_credits: 10000,
      out_of_credits: true,
    });
    expect(r).toMatchObject({
      monthlyLimit: 100,
      used: 100,
      remaining: 0,
      percentage: 100,
      outOfCredits: true,
      level: "critical",
    });
  });

  it("returns null with no extra usage data", () => {
    expect(parseExtraUsage(undefined, null)).toBeNull();
  });
});

describe("parsePrepaid", () => {
  it("converts cents to major units and upper-cases currency", () => {
    expect(parsePrepaid({ amount: 1234, currency: "usd" })).toEqual({
      amount: 12.34,
      currency: "USD",
    });
  });

  it("rejects negative and non-finite amounts", () => {
    expect(parsePrepaid({ amount: -5 })).toBeNull();
    expect(parsePrepaid({ amount: NaN })).toBeNull();
  });

  it("defaults currency to USD", () => {
    expect(parsePrepaid({ amount: 100 })).toEqual({ amount: 1, currency: "USD" });
  });
});

describe("parseClaudeUsage", () => {
  it("keeps a real 0% session over a stale legacy field", () => {
    const r = parseClaudeUsage({
      five_hour: { utilization: 0 },
      session_usage_percent: 0.5,
    });
    expect(r.session.percentage).toBe(0);
  });

  it("wires extraUsage + prepaidBalance and still builds modelBreakdown", () => {
    const r = parseClaudeUsage(
      {
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000, utilization: 20 },
        limits: [{ percent: 40, scope: { model: { display_name: "Fable" } } }],
      },
      { prepaid: { amount: 2500, currency: "usd" } }
    );
    expect(r.extraUsage?.monthlyLimit).toBe(50);
    expect(r.prepaidBalance).toEqual({ amount: 25, currency: "USD" });
    expect(r.modelBreakdown).toHaveLength(1);
    expect(r.modelBreakdown[0]).toMatchObject({ modelName: "Fable", utilization: 40 });
  });
});
