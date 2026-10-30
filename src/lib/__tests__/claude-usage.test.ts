import { describe, expect, it } from "vitest";
import { claudePlanName, parseClaudeUsage } from "@/lib/providers/claude-usage";
import { claudeShortestWindow } from "@/lib/usage/windows";

const weeklyReset = "2026-11-06T12:00:00Z";
const sessionReset = "2026-10-30T17:00:00Z";

describe("Claude subscription names", () => {
  it.each([
    ["pro", null, "Pro"],
    ["max", "default_claude_max_5x", "Max"],
    ["max", "default_claude_max_20x", "Ultra"],
    ["Max 20x", null, "Ultra"],
    ["ultra", null, "Ultra"],
    ["team", null, "Team"],
    ["enterprise", null, "Enterprise"],
    ["free", null, "Free"],
    ["consumer", "future_tier", null],
  ])("labels %s / %s as %s", (subscription, tier, expected) => {
    expect(claudePlanName(subscription, tier)).toBe(expected);
  });
});

describe("Claude usage limits", () => {
  it.each([null, undefined])("does not invent a five-hour window when the bucket is %s", (five_hour) => {
    const data = parseClaudeUsage({
      five_hour,
      seven_day: { utilization: 86, resets_at: weeklyReset },
    }, "Ultra");
    expect(data.planType).toBe("Ultra");
    expect(data.session).toBeNull();
    expect(data.weekly).toMatchObject({ percentage: 86, resetTime: weeklyReset, level: "critical" });
    expect(claudeShortestWindow(data)).toMatchObject({ label: "7d", percentage: 86, level: "critical" });
  });

  it.each(["Pro", "Max", "Ultra", "Team", "Enterprise"])("retains the reported five-hour limit on %s", (plan) => {
    const data = parseClaudeUsage({
      five_hour: { utilization: 72, resets_at: sessionReset },
      seven_day: { utilization: 25, resets_at: weeklyReset },
    }, plan);
    expect(data.session).toMatchObject({ percentage: 72, resetTime: sessionReset, level: "moderate" });
    expect(claudeShortestWindow(data)?.label).toBe("5h");
  });

  it("preserves a real zero reading rather than falling back to stale legacy values", () => {
    const data = parseClaudeUsage({
      five_hour: { utilization: 0 },
      seven_day: { utilization: 0 },
      session_usage_percent: 0.8,
      weekly_usage_percent: 0.9,
    });
    expect(data.session?.percentage).toBe(0);
    expect(data.weekly?.percentage).toBe(0);
  });

  it("uses legacy fractions only when the corresponding bucket is omitted", () => {
    const data = parseClaudeUsage({ session_usage_percent: 0.4, weekly_usage_percent: 0 });
    expect(data.session?.percentage).toBe(40);
    expect(data.weekly?.percentage).toBe(0);
    expect(parseClaudeUsage({ five_hour: null, session_usage_percent: 0.4 }).session).toBeNull();
  });

  it("reads account-wide limits from the modern limits list", () => {
    const data = parseClaudeUsage({
      five_hour: { utilization: 88 },
      seven_day: { utilization: 99 },
      limits: [
        { kind: "session", percent: 0, resets_at: sessionReset },
        { kind: "weekly_all", percent: 64, resets_at: weeklyReset },
        { kind: "weekly_scoped", percent: 92, resets_at: weeklyReset,
          scope: { model: { id: "claude-fable", display_name: "Fable" } } },
      ],
    });
    expect(data.session?.percentage).toBe(0);
    expect(data.weekly).toMatchObject({ percentage: 64, resetTime: weeklyReset });
    expect(data.modelBreakdown).toEqual([expect.objectContaining({
      modelId: "claude-fable", modelName: "Fable", utilization: 92,
      resetTime: weeklyReset, level: "critical",
    })]);
  });

  it("supports weekly-only modern responses and model-specific limits", () => {
    const data = parseClaudeUsage({ limits: [
      { kind: "weekly_all", percent: 37, resets_at: weeklyReset },
      { kind: "weekly_scoped", percent: 42, scope: { model: { display_name: "Fable" } } },
    ] }, "Ultra");
    expect(data.session).toBeNull();
    expect(data.weekly?.percentage).toBe(37);
    expect(data.modelBreakdown[0].utilization).toBe(42);
  });

  it("does not treat scoped usage as an account-wide limit", () => {
    const data = parseClaudeUsage({ limits: [
      { kind: "session", percent: 80, scope: { surface: "code" } },
      { kind: "weekly_all", percent: 90, scope: { model: { display_name: "Fable" } } },
    ] });
    expect(data.session).toBeNull();
    expect(data.weekly).toBeNull();
  });

  it("preserves legacy per-model weekly usage and reset times", () => {
    const data = parseClaudeUsage({
      seven_day_opus: { utilization: 0, resets_at: weeklyReset },
      seven_day_sonnet: { utilization: 25, resets_at: weeklyReset },
    });
    expect(data.modelBreakdown).toEqual([
      expect.objectContaining({ modelName: "Opus", utilization: 0, resetTime: weeklyReset }),
      expect.objectContaining({ modelName: "Sonnet", utilization: 25, resetTime: weeklyReset }),
    ]);
  });

  it("does not manufacture limits from an empty or invalid response", () => {
    for (const response of [{}, { five_hour: null, seven_day: null },
      { five_hour: { utilization: NaN }, seven_day: { utilization: Infinity } }]) {
      const data = parseClaudeUsage(response);
      expect(data.session).toBeNull();
      expect(data.weekly).toBeNull();
      expect(claudeShortestWindow(data)).toBeNull();
    }
  });
});
