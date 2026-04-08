"use client";

import type { AnalyticsOverview } from "@/types";

interface OverviewCardsProps {
  data: AnalyticsOverview | null;
  loading: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

export function OverviewCards({ data, loading }: OverviewCardsProps) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="h-3 w-16 rounded bg-zinc-800" />
            <div className="mt-2 h-6 w-20 rounded bg-zinc-800" />
          </div>
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "Total Cost",
      value: `$${data.total_cost.toFixed(2)}`,
      sub: data.cost_change_pct !== 0
        ? `${data.cost_change_pct > 0 ? "+" : ""}${data.cost_change_pct.toFixed(1)}% vs prev`
        : null,
      subColor: data.cost_change_pct > 0 ? "text-red-400" : "text-emerald-400",
    },
    {
      label: "Sessions",
      value: String(data.session_count),
      sub: `avg ${formatDuration(data.avg_session_duration_ms)} per session`,
      subColor: "text-zinc-500",
    },
    {
      label: "Tokens Used",
      value: formatTokens(data.total_input_tokens + data.total_output_tokens),
      sub: `${formatTokens(data.total_input_tokens)} in / ${formatTokens(data.total_output_tokens)} out`,
      subColor: "text-zinc-500",
    },
    {
      label: "Top Model",
      value: data.top_model.replace("claude-", "").replace("-latest", ""),
      sub: `${data.top_model_cost_pct}% of cost`,
      subColor: "text-zinc-500",
      valueColor: "text-violet-400",
    },
    {
      label: "Tool Calls",
      value: String(data.tool_call_count),
      sub: `${data.tool_success_rate}% success`,
      subColor: data.tool_success_rate >= 95 ? "text-emerald-400" : data.tool_success_rate >= 80 ? "text-amber-400" : "text-red-400",
    },
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">{card.label}</p>
          <p className={`mt-1 text-xl font-bold ${card.valueColor || "text-zinc-100"}`}>{card.value}</p>
          {card.sub && <p className={`mt-0.5 text-[10px] ${card.subColor}`}>{card.sub}</p>}
        </div>
      ))}
    </div>
  );
}
