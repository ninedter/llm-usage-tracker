"use client";

import type { TrendPoint } from "@/types";

interface TrendChartProps {
  data: TrendPoint[];
  loading: boolean;
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TrendChart({ data, loading }: TrendChartProps) {
  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="h-4 w-32 rounded bg-zinc-800" />
        <div className="mt-4 flex items-end gap-2 h-24">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex-1 rounded-t bg-zinc-800" style={{ height: `${30 + ((i * 37) % 60)}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm text-zinc-600 text-center py-8">No trend data for this period</p>
      </div>
    );
  }

  const hasCostData = data.some((d) => d.cost > 0);
  const hourly = data[0]?.date.includes("T") ?? false;
  const maxCost = Math.max(...data.map((d) => d.cost), 0.01);
  const activityOf = (p: TrendPoint) => (hasCostData ? p.tokens : p.events);
  const maxActivity = Math.max(...data.map(activityOf), 1);
  const todayStr = localDateStr(new Date());

  // Label every bar when there's room; thin out for dense ranges
  const labelStep = data.length <= 16 ? 1 : Math.ceil(data.length / 10);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-zinc-200">
          {hasCostData ? "Cost & Token Trend" : "Activity Trend"}
        </p>
        <div className="flex items-center gap-3 text-sm">
          {hasCostData && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
              <span className="text-zinc-400">Cost</span>
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
            <span className="text-zinc-400">{hasCostData ? "Tokens" : "Events"}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-violet-500" />
            <span className="text-zinc-400">Sessions</span>
          </span>
        </div>
      </div>

      <div className="flex items-end gap-px sm:gap-1" style={{ height: 108 }}>
        {data.map((point, i) => {
          const costH = (point.cost / maxCost) * 100;
          const activity = activityOf(point);
          const activityH = (activity / maxActivity) * 100;
          const isToday = !hourly && point.date === todayStr;
          const showLabel = i % labelStep === 0 || isToday || i === data.length - 1;
          const label = formatDateLabel(point.date, hourly);
          const empty = point.cost === 0 && activity === 0 && point.sessions === 0;

          return (
            <div key={point.date} className="flex-1 min-w-0 flex flex-col items-center gap-0.5 group relative">
              <div className="absolute bottom-full mb-2 hidden group-hover:block z-10 pointer-events-none">
                <div className="rounded-md bg-zinc-700 px-2 py-1 text-xs text-zinc-200 whitespace-nowrap shadow-lg">
                  <p className="font-medium">{hourly ? point.date.replace("T", " ") : point.date}</p>
                  {hasCostData && <p className="text-emerald-300">${point.cost.toFixed(2)}</p>}
                  <p className="text-blue-300">{activity.toLocaleString()} {hasCostData ? "tokens" : "events"}</p>
                  <p className="text-violet-300">{point.sessions} session{point.sessions === 1 ? "" : "s"}</p>
                </div>
              </div>
              <div className="w-full flex gap-0.5 items-end justify-center border-b border-zinc-800" style={{ height: 80 }}>
                {empty ? (
                  <div className="w-3/5 rounded-t bg-zinc-800/60" style={{ height: 2 }} />
                ) : (
                  <>
                    {hasCostData && point.cost > 0 && (
                      <div
                        className="w-2/5 rounded-t bg-emerald-500 transition-all"
                        style={{ height: `${Math.max(costH, 2)}%` }}
                      />
                    )}
                    <div
                      className={`rounded-t transition-all ${hasCostData ? "w-2/5" : "w-3/5"} ${activity > 0 ? "bg-blue-500/70 group-hover:bg-blue-400" : "bg-zinc-800/60"}`}
                      style={{ height: activity > 0 ? `${Math.max(activityH, 2)}%` : 2 }}
                    />
                  </>
                )}
              </div>
              {point.sessions > 0 ? (
                <span className={`text-xs font-mono leading-none ${isToday ? "text-violet-300" : "text-violet-400/80"}`}>
                  {point.sessions}
                </span>
              ) : (
                <span className="text-xs leading-none text-transparent select-none">0</span>
              )}
              <span className={`text-xs truncate max-w-full ${isToday ? "text-violet-400 font-medium" : "text-zinc-600"} ${showLabel ? "" : "invisible"}`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-right text-xs text-zinc-600">
        Numbers under bars = sessions started that {hourly ? "hour" : "day"}
      </p>
    </div>
  );
}

function formatDateLabel(date: string, hourly: boolean): string {
  if (hourly) {
    return date.split("T")[1]?.slice(0, 5) || date;
  }
  const d = new Date(date + "T12:00:00");
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
