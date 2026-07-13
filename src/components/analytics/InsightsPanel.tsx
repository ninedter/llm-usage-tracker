"use client";

import type { UsageInsights } from "@/types";

interface InsightsPanelProps {
  data: UsageInsights | null;
  loading: boolean;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Monday-first display order, mapping to SQLite %w (0 = Sunday)
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function fmtDay(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function heatColor(intensity: number): string {
  if (intensity <= 0) return "rgba(63, 63, 70, 0.35)"; // zinc-700-ish empty cell
  const alpha = 0.25 + intensity * 0.75;
  return `rgba(139, 92, 246, ${alpha.toFixed(2)})`; // violet-500 ramp
}

export function InsightsPanel({ data, loading }: InsightsPanelProps) {
  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-zinc-800" />
          ))}
        </div>
        <div className="h-40 rounded-lg bg-zinc-800" />
      </div>
    );
  }

  const { heatmap, projects, stats } = data;
  const hasActivity = heatmap.length > 0 || projects.some((p) => p.events > 0);

  if (!hasActivity) {
    return <p className="text-xs text-zinc-600 text-center py-10">No activity in this period</p>;
  }

  const cellMap = new Map(heatmap.map((c) => [`${c.dow}-${c.hour}`, c.events]));
  const maxCell = Math.max(...heatmap.map((c) => c.events), 1);
  const maxProjectEvents = Math.max(...projects.map((p) => p.events), 1);
  const totalToolCalls = stats.explore_calls + stats.modify_calls;
  const explorePct = totalToolCalls > 0 ? Math.round((stats.explore_calls / totalToolCalls) * 100) : 0;

  const statCards: { label: string; value: string; sub?: string }[] = [
    {
      label: "Active Days",
      value: `${stats.active_days} / ${stats.total_days}`,
      sub: `${Math.round((stats.active_days / Math.max(stats.total_days, 1)) * 100)}% of period`,
    },
    {
      label: "Current Streak",
      value: `${stats.current_streak} day${stats.current_streak === 1 ? "" : "s"}`,
      sub: stats.current_streak > 0 ? "keep it going" : "no recent activity",
    },
    {
      label: "Peak Hour",
      value: stats.peak_hour ? `${String(stats.peak_hour.hour).padStart(2, "0")}:00` : "—",
      sub: stats.peak_hour ? `${stats.peak_hour.events.toLocaleString()} events` : undefined,
    },
    {
      label: "Busiest Day",
      value: stats.busiest_day ? fmtDay(stats.busiest_day.date) : "—",
      sub: stats.busiest_day ? `${stats.busiest_day.events.toLocaleString()} events` : undefined,
    },
    {
      label: "Longest Session",
      value: fmtDuration(stats.longest_session_ms),
    },
    {
      label: "Events / Session",
      value: stats.avg_events_per_session.toLocaleString(),
      sub: "average",
    },
    {
      label: "Explore vs Modify",
      value: totalToolCalls > 0 ? `${explorePct}%` : "—",
      sub: totalToolCalls > 0 ? `${stats.explore_calls.toLocaleString()} read · ${stats.modify_calls.toLocaleString()} write` : undefined,
    },
    {
      label: "Top Tool",
      value: stats.top_tool ?? "—",
    },
  ];

  return (
    <div className="p-3 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {statCards.map((card) => (
          <div key={card.label} className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">{card.label}</p>
            <p className="mt-1 text-sm font-bold text-zinc-200 truncate" title={card.value}>{card.value}</p>
            {card.sub && <p className="text-[9px] text-zinc-600 truncate">{card.sub}</p>}
          </div>
        ))}
      </div>

      {/* Activity heatmap */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Activity Heatmap</p>
          <div className="flex items-center gap-1 text-[8px] text-zinc-600">
            <span>less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <span key={v} className="inline-block h-2 w-2 rounded-[2px]" style={{ backgroundColor: heatColor(v) }} />
            ))}
            <span>more</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            {DAY_ORDER.map((dow) => (
              <div key={dow} className="flex items-center gap-1 mb-1">
                <span className="text-[8px] text-zinc-500 font-mono w-7 shrink-0 text-right">{DAY_LABELS[dow]}</span>
                <div className="flex flex-1 gap-[3px]">
                  {Array.from({ length: 24 }, (_, hour) => {
                    const n = cellMap.get(`${dow}-${hour}`) || 0;
                    return (
                      <div
                        key={hour}
                        className="h-4 flex-1 rounded-[2px]"
                        style={{ backgroundColor: heatColor(n / maxCell) }}
                        title={`${DAY_LABELS[dow]} ${String(hour).padStart(2, "0")}:00 — ${n.toLocaleString()} events`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-1 mt-0.5">
              <span className="w-7 shrink-0" />
              <div className="flex flex-1 gap-[3px]">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour} className="flex-1 text-center text-[7px] text-zinc-600 font-mono">
                    {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Project breakdown */}
      {projects.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Activity by Project</p>
          <div className="space-y-1.5">
            {projects.map((p) => {
              const name = p.project || "(no project)";
              return (
                <div key={name} className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-400 font-mono w-36 shrink-0 text-right truncate" title={name}>
                    {name}
                  </span>
                  <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${(p.events / maxProjectEvents) * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-600 font-mono w-14 shrink-0 text-right" title="events">
                    {p.events.toLocaleString()}
                  </span>
                  <span className="text-[9px] text-zinc-600 font-mono w-20 shrink-0 text-right">
                    {p.sessions} sess · {p.active_days}d
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
