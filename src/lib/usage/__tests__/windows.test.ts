import { describe, it, expect } from "vitest";
import {
  claudeShortestWindow,
  openaiShortestWindow,
  compactWindowLabel,
} from "@/lib/usage/windows";
import type { ClaudeUsageData, OpenAIUsageData, UsageWindow } from "@/types";

const win = (percentage: number): UsageWindow => ({
  tokensUsed: 0,
  tokenLimit: 0,
  percentage,
  resetTime: null,
  level: "safe",
});

const claude = (session: number, weekly: number): ClaudeUsageData => ({
  session: win(session),
  weekly: win(weekly),
  modelBreakdown: [],
  lastUpdated: "",
});

const openai = (windows: OpenAIUsageData["windows"]): OpenAIUsageData => ({
  planType: "Pro Lite",
  windows,
  featureLimits: [],
  resetCreditsAvailable: null,
  resetCredits: [],
  lastUpdated: "",
});

describe("compactWindowLabel", () => {
  it("renders hours under a day and days beyond", () => {
    expect(compactWindowLabel(5 * 3600)).toBe("5h");
    expect(compactWindowLabel(7 * 86400)).toBe("7d");
    expect(compactWindowLabel(0)).toBe("");
  });
});

describe("claudeShortestWindow", () => {
  it("picks the 5h session window over the 7d weekly one", () => {
    const w = claudeShortestWindow(claude(40, 12))!;
    expect(w.label).toBe("5h");
    expect(w.percentage).toBe(40);
  });
});

describe("openaiShortestWindow", () => {
  it("picks the 7d window when that is all the API reports", () => {
    const w = openaiShortestWindow(
      openai([
        { label: "7-Day Window", windowSeconds: 604800, percentage: 16, resetTime: null, level: "safe" },
      ])
    )!;
    expect(w.label).toBe("7d");
    expect(w.percentage).toBe(16);
  });

  // The behaviour that matters: nothing is pinned to 7d. If OpenAI reverts to a
  // 5h primary limit, the strip must follow it without a code change.
  it("follows a shorter window automatically if the plan gains one", () => {
    const w = openaiShortestWindow(
      openai([
        { label: "7-Day Window", windowSeconds: 604800, percentage: 16, resetTime: null, level: "safe" },
        { label: "5-Hour Window", windowSeconds: 18000, percentage: 73, resetTime: null, level: "moderate" },
      ])
    )!;
    expect(w.label).toBe("5h");
    expect(w.percentage).toBe(73);
    expect(w.level).toBe("moderate");
  });

  it("returns null when the provider reports no windows", () => {
    expect(openaiShortestWindow(openai([]))).toBeNull();
  });
});
