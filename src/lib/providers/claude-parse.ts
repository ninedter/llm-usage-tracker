import type { ClaudeExtraUsage, ClaudeUsageData, MoneyAmount } from "@/types";
import { getUsageLevel } from "../constants";

// Pure parsing for Claude usage payloads, kept free of fetch/Keychain so the
// upstream (undocumented, shifting) shapes can be unit tested.

// Response from claude.ai/api/organizations/{orgId}/usage
// AND api.anthropic.com/api/oauth/usage
interface UsageBucket {
  utilization?: number | null; // 0-100
  resets_at?: string | null;
}

// Modern per-limit entries. Per-model usage (e.g. Fable) only appears here,
// as weekly_scoped entries with scope.model — the seven_day_<model> buckets
// are null on current plans.
interface UsageLimit {
  kind?: string; // "session" | "weekly_all" | "weekly_scoped" | ...
  group?: string; // "session" | "weekly"
  percent?: number; // 0-100
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

// Numbers may arrive as numeric strings; num() normalizes both.
type RawNumber = number | string | null;

// Extra usage amounts are minor units (cents), not dollars.
export interface ClaudeExtraUsageRaw {
  is_enabled?: boolean | null;
  monthly_limit?: RawNumber; // missing/null = no cap
  used_credits?: RawNumber;
  utilization?: RawNumber; // 0-100
  currency?: string | null;
}

// claude.ai/api/organizations/{org}/prepaid/credits (cents)
export interface ClaudePrepaidRaw {
  amount?: RawNumber;
  currency?: string | null;
}

// claude.ai/api/organizations/{org}/overage_spend_limit (cents)
export interface ClaudeSpendLimitRaw {
  is_enabled?: boolean | null;
  monthly_credit_limit?: RawNumber;
  used_credits?: RawNumber;
  currency?: string | null;
  out_of_credits?: boolean | null;
}

export interface ClaudeUsageResponse {
  five_hour?: UsageBucket;
  seven_day?: UsageBucket;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  limits?: UsageLimit[] | null;
  extra_usage?: ClaudeExtraUsageRaw | null;
  // Legacy field names (kept for backwards compat)
  session_usage_percent?: number;
  weekly_usage_percent?: number;
}

// Upstream sometimes serializes amounts as numeric strings ("5000"); accept
// those, but not "" (Number("") is 0) or garbage. null = no usable number.
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Cents -> major units, rounded so float noise (1720.0000001) can't leak into the UI.
const centsToMajor = (cents: number) => Math.round(cents) / 100;

const normalizeCurrency = (c: string | null | undefined) =>
  typeof c === "string" && c.trim() ? c.trim().toUpperCase() : "USD";

export function parseExtraUsage(
  raw: ClaudeExtraUsageRaw | null | undefined,
  spendLimit?: ClaudeSpendLimitRaw | null
): ClaudeExtraUsage | null {
  if (!raw && !spendLimit) return null;

  // extra_usage is authoritative; the spend-limit endpoint only fills what it omits.
  const limitCents = num(raw?.monthly_limit) ?? num(spendLimit?.monthly_credit_limit);
  const usedCents = num(raw?.used_credits) ?? num(spendLimit?.used_credits) ?? 0;

  // Upstream utilization wins; otherwise derive it from the cap
  const percentage =
    num(raw?.utilization) ??
    (limitCents != null && limitCents > 0 ? (usedCents / limitCents) * 100 : null);

  return {
    enabled: raw?.is_enabled ?? spendLimit?.is_enabled ?? false,
    currency: normalizeCurrency(raw?.currency ?? spendLimit?.currency),
    monthlyLimit: limitCents != null ? centsToMajor(limitCents) : null,
    used: centsToMajor(usedCents),
    remaining: limitCents != null ? centsToMajor(Math.max(0, limitCents - usedCents)) : null,
    percentage,
    level: getUsageLevel(percentage ?? 0),
    outOfCredits:
      typeof spendLimit?.out_of_credits === "boolean"
        ? spendLimit.out_of_credits
        : percentage != null && percentage >= 100,
  };
}

export function parsePrepaid(raw: ClaudePrepaidRaw | null | undefined): MoneyAmount | null {
  // A negative or non-numeric balance is a malformed response, not "no credit".
  const amount = num(raw?.amount);
  if (!raw || amount == null || amount < 0) return null;
  return { amount: centsToMajor(amount), currency: normalizeCurrency(raw.currency) };
}

export function parseClaudeUsage(
  usage: ClaudeUsageResponse,
  extras?: { prepaid?: ClaudePrepaidRaw | null; spendLimit?: ClaudeSpendLimitRaw | null }
): ClaudeUsageData {
  // New format: five_hour.utilization (0-100), seven_day.utilization (0-100)
  const fiveHourUtil = usage.five_hour?.utilization;
  const sevenDayUtil = usage.seven_day?.utilization;
  const fiveHourReset = usage.five_hour?.resets_at ?? null;
  const sevenDayReset = usage.seven_day?.resets_at ?? null;

  // Legacy fallback only when the new field is absent: a genuine 0% must not
  // be overridden by a stale legacy value.
  const sessionPct =
    fiveHourUtil != null ? fiveHourUtil : (usage.session_usage_percent ?? 0) * 100;
  const weeklyPct =
    sevenDayUtil != null ? sevenDayUtil : (usage.weekly_usage_percent ?? 0) * 100;

  // Per-model breakdown from scoped limits entries (e.g. Fable, Opus).
  // The scoped percent shares the weekly window, so it renders alongside
  // the 7-day bar the same way the old seven_day_* buckets did.
  const modelBreakdown: ClaudeUsageData["modelBreakdown"] = [];

  for (const limit of usage.limits ?? []) {
    const modelName = limit.scope?.model?.display_name;
    if (modelName && limit.percent != null) {
      modelBreakdown.push({
        modelId: modelName.toLowerCase(),
        modelName,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: limit.percent,
        level: getUsageLevel(limit.percent),
      });
    }
  }

  // Legacy seven_day_* buckets (null on current plans)
  if (modelBreakdown.length === 0) {
    if (usage.seven_day_opus?.utilization != null) {
      const opusUtil = usage.seven_day_opus.utilization;
      modelBreakdown.push({
        modelId: "opus",
        modelName: "Opus",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: opusUtil,
        level: getUsageLevel(opusUtil),
      });
    }

    if (usage.seven_day_sonnet?.utilization != null) {
      const sonnetUtil = usage.seven_day_sonnet.utilization;
      modelBreakdown.push({
        modelId: "sonnet",
        modelName: "Sonnet",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: sonnetUtil,
        level: getUsageLevel(sonnetUtil),
      });
    }
  }

  return {
    session: {
      tokensUsed: 0,
      tokenLimit: 0,
      percentage: sessionPct,
      resetTime: fiveHourReset,
      level: getUsageLevel(sessionPct),
    },
    weekly: {
      tokensUsed: 0,
      tokenLimit: 0,
      percentage: weeklyPct,
      resetTime: sevenDayReset,
      level: getUsageLevel(weeklyPct),
    },
    modelBreakdown,
    extraUsage: parseExtraUsage(usage.extra_usage, extras?.spendLimit),
    prepaidBalance: parsePrepaid(extras?.prepaid),
    lastUpdated: new Date().toISOString(),
  };
}
