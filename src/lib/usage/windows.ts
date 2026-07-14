import type { ClaudeUsageData, OpenAIUsageData, UsageLevel, UsageWindow } from "@/types";

// Claude's plan windows aren't self-describing (the API gives us fixed
// session/weekly fields), so their lengths live here. OpenAI's come from the
// API itself.
const CLAUDE_SESSION_WINDOW_SECONDS = 5 * 3600; // 5h
const CLAUDE_WEEKLY_WINDOW_SECONDS = 7 * 86400; // 7d

export interface StripWindow {
  /** Compact duration of the window itself, e.g. "5h" / "7d" */
  label: string;
  percentage: number;
  level: UsageLevel;
  windowSeconds: number;
  resetTime: string | null;
}

/** "5h", "7d" — derived from the window length, never hardcoded per provider. */
export function compactWindowLabel(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function pickShortest(windows: StripWindow[]): StripWindow | null {
  if (windows.length === 0) return null;
  return windows.reduce((a, b) => (b.windowSeconds < a.windowSeconds ? b : a));
}

function toStripWindow(w: UsageWindow, windowSeconds: number): StripWindow {
  return {
    label: compactWindowLabel(windowSeconds),
    percentage: w.percentage,
    level: w.level,
    windowSeconds,
    resetTime: w.resetTime,
  };
}

/**
 * Claude's shortest reset window (the 5h session window today). Chosen by
 * comparing window lengths rather than hardcoding "session", so if the plan's
 * windows change the strip follows.
 */
export function claudeShortestWindow(data: ClaudeUsageData): StripWindow | null {
  const candidates: StripWindow[] = [];
  if (data.session) candidates.push(toStripWindow(data.session, CLAUDE_SESSION_WINDOW_SECONDS));
  if (data.weekly) candidates.push(toStripWindow(data.weekly, CLAUDE_WEEKLY_WINDOW_SECONDS));
  return pickShortest(candidates);
}

/**
 * OpenAI's shortest reset window, picked from whatever windows the API reports
 * (a 7d window today). If the plan's primary window reverts to 5h, this picks
 * that up automatically — nothing here is pinned to a duration.
 */
export function openaiShortestWindow(data: OpenAIUsageData): StripWindow | null {
  const candidates = (data.windows ?? [])
    .filter((w) => w.windowSeconds > 0)
    .map<StripWindow>((w) => ({
      label: compactWindowLabel(w.windowSeconds),
      percentage: w.percentage,
      level: w.level,
      windowSeconds: w.windowSeconds,
      resetTime: w.resetTime,
    }));
  return pickShortest(candidates);
}
