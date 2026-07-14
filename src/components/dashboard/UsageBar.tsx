"use client";

import type { UsageLevel } from "@/types";

const BAR_COLORS: Record<UsageLevel, string> = {
  safe: "bg-emerald-500",
  moderate: "bg-amber-500",
  critical: "bg-red-500",
};

interface UsageBarProps {
  label: string;
  percentage: number;
  level: UsageLevel;
  used?: string;
  limit?: string;
  resetTime?: string | null;
}

export function UsageBar({
  label,
  percentage,
  level,
  used,
  limit,
  resetTime,
}: UsageBarProps) {
  const clampedPct = Math.min(100, Math.max(0, percentage));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </span>
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {clampedPct.toFixed(1)}%
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`h-full rounded-full transition-all duration-500 ${BAR_COLORS[level]}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      {(used || limit || resetTime) && (
        <div className="mt-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          {used && limit && (
            <span>
              {used} / {limit}
            </span>
          )}
          {resetTime && (
            <span>Resets {formatResetTime(resetTime)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function formatResetTime(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs <= 0) return "soon";

    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);

    if (days > 0) return `in ${days}d ${hours}h`;
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  } catch {
    return "";
  }
}
