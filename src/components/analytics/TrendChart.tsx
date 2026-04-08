"use client";

import type { TrendPoint } from "@/types";

interface TrendChartProps {
  data: TrendPoint[];
  loading: boolean;
}

export function TrendChart({ data, loading }: TrendChartProps) {
  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="h-4 w-32 rounded bg-zinc-800" />
        <div className="mt-4 flex items-end gap-2 h-24">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex-1 rounded-t bg-zinc-800" style={{ height: `${30 + Math.random() * 60}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs text-zinc-600 text-center py-8">No trend data for this period</p>
      </div>
    );
  }

  const maxCost = Math.max(...data.map((d) => d.cost), 0.01);
  const maxTokens = Math.max(...data.map((d) => d.tokens), 1);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-200">Cost & Token Trend</p>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            <span className="text-zinc-400">Cost</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
            <span className="text-zinc-400">Tokens</span>
          </span>
        </div>
      </div>

      <div className="flex items-end gap-1.5" style={{ height: 100 }}>
        {data.map((point, i) => {
          const costH = maxCost > 0 ? (point.cost / maxCost) * 100 : 0;
          const tokenH = maxTokens > 0 ? (point.tokens / maxTokens) * 100 : 0;
          const label = formatDateLabel(point.date);
          const isToday = point.date === new Date().toISOString().slice(0, 10);

          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
              <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
                <div className="rounded-md bg-zinc-700 px-2 py-1 text-[9px] text-zinc-200 whitespace-nowrap shadow-lg">
                  <p className="font-medium">{point.date}</p>
                  <p className="text-emerald-300">${point.cost.toFixed(2)}</p>
                  <p className="text-blue-300">{point.tokens.toLocaleString()} tokens</p>
                  <p className="text-zinc-400">{point.sessions} sessions</p>
                </div>
              </div>
              <div className="w-full flex gap-0.5 items-end justify-center" style={{ height: 80 }}>
                <div
                  className="w-2/5 rounded-t bg-emerald-500 transition-all"
                  style={{ height: `${Math.max(costH, 2)}%` }}
                />
                <div
                  className="w-2/5 rounded-t bg-blue-500/60 transition-all"
                  style={{ height: `${Math.max(tokenH, 2)}%` }}
                />
              </div>
              <span className={`text-[8px] ${isToday ? "text-violet-400 font-medium" : "text-zinc-600"}`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDateLabel(date: string): string {
  if (date.includes("T")) {
    return date.split("T")[1]?.slice(0, 5) || date;
  }
  const d = new Date(date + "T12:00:00");
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}
