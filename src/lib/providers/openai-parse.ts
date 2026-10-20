import type {
  OpenAICredits,
  OpenAIRateWindow,
  OpenAIResetCredit,
  OpenAIUsageData,
} from "@/types";
import { getUsageLevel } from "../constants";

// Pure parsing for ChatGPT/Codex usage payloads, kept free of fetch/auth so
// the upstream (undocumented, shifting) shapes can be unit tested.

// Response from chatgpt.com/backend-api/wham/usage — the endpoint Codex CLI
// uses for its /status rate-limit display.
interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number; // unix seconds
}

interface WhamRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WhamWindow | null;
  secondary_window?: WhamWindow | null;
}

export interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: WhamRateLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    rate_limit?: WhamRateLimit | null;
  }> | null;
  rate_limit_reset_credits?: { available_count?: number } | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
  rate_limit_reached_type?: string | null;
}

// Response from chatgpt.com/backend-api/wham/rate-limit-reset-credits — the
// endpoint Codex CLI uses to list individual reset credits.
interface WhamResetCredit {
  id?: string;
  status?: string;
  expires_at?: string | null;
  title?: string | null;
}

export interface WhamResetCreditsResponse {
  credits?: WhamResetCredit[] | null;
  available_count?: number;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

function windowLabel(seconds: number | undefined): string {
  if (!seconds) return "Usage Window";
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? "1-Day Window" : `${days}-Day Window`;
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? "1-Hour Window" : `${hours}-Hour Window`;
}

function parseWindow(
  win: WhamWindow | null | undefined,
  label?: string
): OpenAIRateWindow | null {
  if (!win || win.used_percent == null) return null;
  const pct = win.used_percent;
  return {
    label: label ?? windowLabel(win.limit_window_seconds),
    windowSeconds: win.limit_window_seconds ?? 0,
    percentage: pct,
    resetTime:
      win.reset_at != null ? new Date(win.reset_at * 1000).toISOString() : null,
    level: getUsageLevel(pct),
  };
}

export function parseCredits(raw: WhamUsageResponse["credits"]): OpenAICredits | null {
  if (!raw) return null;
  // balance arrives as a string ("9.99"); Number("") is 0 and Number("abc") is
  // NaN, both of which collapse to null below
  const n = typeof raw.balance === "number" ? raw.balance : Number(raw.balance);
  return {
    hasCredits: raw.has_credits === true,
    unlimited: raw.unlimited === true,
    balance: raw.balance != null && Number.isFinite(n) && n > 0 ? n : null,
  };
}

export function parseOpenAIUsage(
  usage: WhamUsageResponse,
  creditDetails: WhamResetCreditsResponse | null
): OpenAIUsageData {
  const windows: OpenAIRateWindow[] = [];
  const primary = parseWindow(usage.rate_limit?.primary_window);
  const secondary = parseWindow(usage.rate_limit?.secondary_window);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  // Show the shorter window first, matching the Claude card's 5h-then-7d order
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);

  const featureLimits: OpenAIRateWindow[] = [];
  for (const extra of usage.additional_rate_limits ?? []) {
    const name = extra.limit_name;
    const raws = [extra.rate_limit?.primary_window, extra.rate_limit?.secondary_window];
    const present = raws.filter((w) => parseWindow(w) !== null);
    // With two windows, disambiguate each by its duration
    const suffix = present.length > 1;
    for (const raw of present) {
      const label = suffix ? `${name} · ${windowLabel(raw!.limit_window_seconds)}` : name;
      featureLimits.push(parseWindow(raw, label)!);
    }
  }

  const rawPlan = usage.plan_type ?? "";
  const planType =
    PLAN_NAMES[rawPlan] ??
    (rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : "");

  const resetCredits: OpenAIResetCredit[] = (creditDetails?.credits ?? [])
    .filter((c) => c.status === "available")
    .map((c, i) => ({
      id: c.id ?? `credit-${i}`,
      title: c.title || "Rate-limit reset",
      expiresAt: c.expires_at ?? null,
    }));

  const availableCount =
    creditDetails?.available_count ?? usage.rate_limit_reset_credits?.available_count;

  return {
    planType,
    windows,
    featureLimits,
    resetCreditsAvailable: typeof availableCount === "number" ? availableCount : null,
    resetCredits,
    credits: parseCredits(usage.credits),
    creditsDepleted: usage.rate_limit_reached_type?.endsWith("credits_depleted") ?? false,
    lastUpdated: new Date().toISOString(),
  };
}
