import { describe, it, expect } from "vitest";
import { parseClaudeUsage, parseCloudCredits, parseExtraUsage, parsePrepaid } from "../claude-parse";

describe("cloud session credits", () => {
  it("reads the observed dollar-denominated bucket without dividing it by 100", () => {
    const r = parseClaudeUsage({ iguana_necktie: {
      limit_dollars: 250, used_dollars: 156.926742,
      remaining_dollars: 93.07325800000001, utilization: 62.7706968,
      resets_at: "2026-11-05T07:59:00+00:00",
    } });
    expect(r.cloudCredits).toMatchObject({
      total: 250, used: 156.926742, remaining: 93.07325800000001,
      percentage: 62.7706968, currency: "USD", expiresAt: "2026-11-05T07:59:00+00:00",
    });
    expect(r.prepaidBalance).toBeNull();
  });

  it("accepts numeric strings and retains depleted credits", () => {
    expect(parseCloudCredits({ limit_dollars: "250", remaining_dollars: "0" }))
      .toMatchObject({ total: 250, used: 250, remaining: 0, percentage: 100 });
  });

  it("marks an expired grant without erasing its reported unused balance", () => {
    expect(parseCloudCredits({ limit_dollars: 250, remaining_dollars: 93,
      resets_at: "2000-11-05T07:59:00Z" }))
      .toMatchObject({ expired: true, remaining: 93 });
    expect(parseCloudCredits({ limit_dollars: 250, remaining_dollars: 93,
      resets_at: "2099-11-05T07:59:00Z" })?.expired).toBe(false);
  });

  it("does not fabricate missing or malformed balances", () => {
    for (const raw of [null, {}, { limit_dollars: 250 },
      { limit_dollars: 250, remaining_dollars: -1 },
      { limit_dollars: 250, remaining_dollars: 251 },
      { limit_dollars: 250, remaining_dollars: NaN }]) {
      expect(parseCloudCredits(raw)).toBeNull();
    }
    expect(parseClaudeUsage({}).cloudCredits).toBeNull();
  });
});

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

  it("defaults currency to USD", () => {
    expect(parsePrepaid({ amount: 100 })).toEqual({ amount: 1, currency: "USD" });
  });
});

describe("parseClaudeUsage", () => {
  it("omits the zeroed session placeholder returned for verified Ultra accounts", () => {
    const r = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 25, resets_at: "2026-11-07T03:00:00Z" },
      limits: [{ kind: "session", percent: 0, resets_at: null }],
    });
    expect(r.session).toBeNull();
    expect(r.weekly.percentage).toBe(25);
  });

  it("does not invent a session when the bucket is absent or null", () => {
    expect(parseClaudeUsage({}).session).toBeNull();
    expect(parseClaudeUsage({ five_hour: null }).session).toBeNull();
  });

  it("keeps nonzero session usage even without a reset timestamp", () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 12 } }).session?.percentage).toBe(12);
    expect(parseClaudeUsage({ session_usage_percent: 0.12 }).session?.percentage).toBe(12);
  });

  it("keeps a real 0% session over a stale legacy field", () => {
    const r = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: "2026-11-01T00:00:00Z" },
      session_usage_percent: 0.5,
    });
    expect(r.session?.percentage).toBe(0);
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
