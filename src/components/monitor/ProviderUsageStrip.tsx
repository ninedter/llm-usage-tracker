"use client";

import { useClaudeUsage, useHealth, useOpenAIUsage } from "@/hooks/use-usage-data";
import { PROVIDER_INFO } from "@/lib/constants";
import {
  claudeShortestWindow,
  openaiShortestWindow,
  type StripWindow,
} from "@/lib/usage/windows";
import type { ProviderId, UsageLevel } from "@/types";

const BAR_COLORS: Record<UsageLevel, string> = {
  safe: "bg-emerald-500",
  moderate: "bg-amber-500",
  critical: "bg-red-500",
};

/**
 * Live quota for both providers at a glance — each provider's *shortest* reset
 * window only (Claude's 5h, OpenAI's 7d today). The window is chosen
 * dynamically in @/lib/usage/windows, so this follows the provider if their
 * limits change.
 */
export function ProviderUsageStrip() {
  const { data: health } = useHealth();
  const claudeConnected = !!health?.claude.connected;
  const openaiConnected = !!health?.openai?.connected;

  const { data: claude } = useClaudeUsage(claudeConnected);
  const { data: openai } = useOpenAIUsage(openaiConnected);

  const rows: { id: ProviderId; window: StripWindow }[] = [];
  const claudeWindow = claude ? claudeShortestWindow(claude) : null;
  const openaiWindow = openai ? openaiShortestWindow(openai) : null;
  if (claudeWindow) rows.push({ id: "claude", window: claudeWindow });
  if (openaiWindow) rows.push({ id: "openai", window: openaiWindow });

  if (rows.length === 0) return null;

  return (
    <div className="mb-4 flex-shrink-0 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="grid gap-x-8 gap-y-2.5 lg:grid-cols-2">
        {rows.map(({ id, window }) => (
          <StripRow key={id} providerId={id} window={window} />
        ))}
      </div>
    </div>
  );
}

function StripRow({ providerId, window: w }: { providerId: ProviderId; window: StripWindow }) {
  const info = PROVIDER_INFO[providerId];
  const pct = Math.min(100, Math.max(0, w.percentage));

  return (
    <div className="flex items-center gap-3">
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: info.color }}
      />
      <span className="w-48 flex-shrink-0 truncate text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {info.displayName}
      </span>
      <span className="w-7 flex-shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">
        {w.label}
      </span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${BAR_COLORS[w.level]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-12 flex-shrink-0 text-right text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {pct.toFixed(0)}%
      </span>
      <span className="hidden w-24 flex-shrink-0 text-right text-xs text-zinc-400 dark:text-zinc-500 xl:block">
        {w.resetTime ? formatReset(w.resetTime) : ""}
      </span>
    </div>
  );
}

function formatReset(iso: string): string {
  try {
    const diffMs = new Date(iso).getTime() - Date.now();
    if (diffMs <= 0) return "resets soon";
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    if (days > 0) return `resets ${days}d ${hours}h`;
    if (hours > 0) return `resets ${hours}h ${minutes}m`;
    return `resets ${minutes}m`;
  } catch {
    return "";
  }
}
