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

  it("accepts monthly_limit as a numeric string", () => {
    const r = parseExtraUsage({ is_enabled: true, monthly_limit: "5000", used_credits: 1000 });
    expect(r).toMatchObject({ monthlyLimit: 50, remaining: 40, percentage: 20 });
  });

  it("accepts used_credits as a numeric string", () => {
    const r = parseExtraUsage({ is_enabled: true, used_credits: "277" });
    expect(r!.used).toBe(2.77);
  });

  it("accepts utilization as a numeric string", () => {
    const r = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1000,
      utilization: "34.4",
    });
    expect(r!.percentage).toBe(34.4);
  });

  it("still rejects empty and non-numeric strings", () => {
    const r = parseExtraUsage({
      is_enabled: true,
      monthly_limit: "",
      used_credits: "abc",
    });
    expect(r).toMatchObject({ monthlyLimit: null, used: 0 });
  });

  it("enabled + spend limit reached -> out of credits", () => {
    const r = parseExtraUsage(
      { is_enabled: true, spend_limit_reached: true },
      { monthly_credit_limit: 5000, used_credits: 5000 }
    );
    expect(r!.outOfCredits).toBe(true);
  });

  it("extra_usage.spend_limit_reached wins over the spend-limit flag", () => {
    const r = parseExtraUsage(
      { is_enabled: true, spend_limit_reached: false },
      { monthly_credit_limit: 5000, used_credits: 100, out_of_credits: true }
    );
    expect(r!.outOfCredits).toBe(false);
  });

  // Live shape (Oct 2026): extra usage switched off, nothing used, yet
  // overage_spend_limit says out_of_credits with a self-selected-limit reason
  it("switched-off extra usage is never out of credits", () => {
    const r = parseExtraUsage(
      {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
        decimal_places: null,
        spend_limit_reached: false,
      },
      {
        is_enabled: false,
        monthly_credit_limit: 5000,
        used_credits: 0,
        currency: "USD",
        out_of_credits: true,
        cap: { money: null, credits: { amount_minor: 5000, exponent: 2 } },
      }
    );
    expect(r).toMatchObject({
      enabled: false,
      outOfCredits: false,
      monthlyLimit: 50,
      used: 0,
      currency: "USD",
    });
  });

  it("honors decimal_places, then the cap exponent, over the cents default", () => {
    expect(parseExtraUsage({ is_enabled: true, used_credits: 1234, decimal_places: 3 })!.used).toBe(1.234);
    expect(
      parseExtraUsage(undefined, {
        is_enabled: true,
        monthly_credit_limit: 500,
        cap: { credits: { amount_minor: 500, exponent: 0 } },
      })!.monthlyLimit
    ).toBe(500);
  });

  it("ignores an unusable exponent", () => {
    expect(parseExtraUsage({ is_enabled: true, used_credits: 250, decimal_places: -1 })!.used).toBe(2.5);
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

  it("accepts the amount as a numeric string", () => {
    expect(parsePrepaid({ amount: "1234", currency: "usd" })).toEqual({
      amount: 12.34,
      currency: "USD",
    });
  });

  // Live shape (Oct 2026): `amount` mirrors balance.credits.amount_minor
  it("parses the live prepaid shape", () => {
    expect(
      parsePrepaid({
        amount: 1234,
        currency: "USD",
        balance: { money: null, credits: { amount_minor: 1234, exponent: 2 } },
      })
    ).toEqual({ amount: 12.34, currency: "USD" });
  });

  it("keeps a zero balance (an account with no prepaid credit)", () => {
    expect(parsePrepaid({ amount: 0, currency: "USD" })).toEqual({ amount: 0, currency: "USD" });
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
