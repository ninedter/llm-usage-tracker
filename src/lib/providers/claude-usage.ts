import type { ClaudeUsageData, UsageWindow } from "@/types";
import { getUsageLevel } from "../constants";

interface UsageBucket {
  utilization?: number;
  resets_at?: string | null;
}

interface UsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
}

export interface ClaudeUsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  limits?: UsageLimit[] | null;
  session_usage_percent?: number;
  weekly_usage_percent?: number;
}

/** Account metadata is only a label; actual limits always come from usage. */
export function claudePlanName(
  subscriptionType?: string | null,
  rateLimitTier?: string | null,
): string | null {
  // Old Max 20x accounts automatically migrate to Ultra. Check the specific
  // rate tier before the generic "max" subscription type.
  const values = [rateLimitTier, subscriptionType]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase().replace(/[\s-]+/g, "_"));
  for (const value of values) {
    if (/(?:^|_)(ultra|max_?20x)(?:_|$)/.test(value)) return "Ultra";
    if (/(?:^|_)enterprise(?:_|$)/.test(value)) return "Enterprise";
    if (/(?:^|_)team(?:_|$)/.test(value)) return "Team";
    if (/(?:^|_)max(?:_?5x)?(?:_|$)/.test(value)) return "Max";
    if (/(?:^|_)pro(?:_|$)/.test(value)) return "Pro";
    if (/(?:^|_)free(?:_|$)/.test(value)) return "Free";
  }
  return null;
}

function usageWindow(
  limit: UsageLimit | undefined,
  bucket: UsageBucket | null | undefined,
  legacyPercent?: number,
): UsageWindow | null {
  // Null explicitly removes a bucket. An omitted bucket may still have a
  // legacy value. Zero is a valid reading and must not trigger a fallback.
  const percentage = limit?.percent ?? bucket?.utilization ??
    (bucket !== null && legacyPercent != null ? legacyPercent * 100 : null);
  if (percentage == null || !Number.isFinite(percentage)) return null;
  return {
    tokensUsed: 0,
    tokenLimit: 0,
    percentage,
    resetTime: limit?.resets_at ?? bucket?.resets_at ?? null,
    level: getUsageLevel(percentage),
  };
}

export function parseClaudeUsage(
  usage: ClaudeUsageResponse,
  planType: string | null = null,
): ClaudeUsageData {
  const limits = usage.limits ?? [];
  // Surface/model-specific limits must not replace the account-wide bars.
  const globalLimits = limits.filter((l) => !l.scope?.model && !l.scope?.surface);
  const session = usageWindow(
    globalLimits.find((l) => l.kind === "session"),
    usage.five_hour,
    usage.session_usage_percent,
  );
  const weekly = usageWindow(
    globalLimits.find((l) => l.kind === "weekly_all"),
    usage.seven_day,
    usage.weekly_usage_percent,
  );

  const modelBreakdown: ClaudeUsageData["modelBreakdown"] = [];
  for (const limit of limits) {
    const model = limit.scope?.model;
    const modelName = model?.display_name;
    if (!modelName || limit.percent == null || !Number.isFinite(limit.percent)) continue;
    if (limit.kind !== "weekly_scoped" && limit.group !== "weekly") continue;
    modelBreakdown.push({
      modelId: model?.id ?? modelName.toLowerCase(),
      modelName,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      utilization: limit.percent,
      level: getUsageLevel(limit.percent),
      resetTime: limit.resets_at ?? null,
    });
  }

  if (modelBreakdown.length === 0) {
    for (const [modelName, bucket] of [
      ["Opus", usage.seven_day_opus],
      ["Sonnet", usage.seven_day_sonnet],
    ] as const) {
      const window = usageWindow(undefined, bucket);
      if (!window) continue;
      modelBreakdown.push({
        modelId: modelName.toLowerCase(),
        modelName,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        utilization: window.percentage,
        level: window.level,
        resetTime: window.resetTime,
      });
    }
  }

  return { planType, session, weekly, modelBreakdown, lastUpdated: new Date().toISOString() };
}
