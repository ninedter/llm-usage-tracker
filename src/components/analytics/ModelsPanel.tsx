"use client";

import type { ModelAnalytics } from "@/types";

interface ModelsPanelProps {
  data: ModelAnalytics | null;
  loading: boolean;
}

const MODEL_COLORS = ["#a78bfa", "#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#22d3ee"];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function shortModelName(model: string): string {
  return model.replace("claude-", "").replace("-latest", "").replace("-20250", "");
}

export function ModelsPanel({ data, loading }: ModelsPanelProps) {
  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { models, trend } = data;
  const totalCost = models.reduce((s, m) => s + m.cost, 0);

  let offset = 25;
  const segments = models.map((m, i) => {
    const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
    const seg = { ...m, pct, color: MODEL_COLORS[i % MODEL_COLORS.length], offset };
    offset -= pct;
    return seg;
  });

  const trendDates = [...new Set(trend.map((t) => t.date))].sort();
  const trendModels = [...new Set(trend.map((t) => t.model))];
  const maxDayCost = Math.max(
    ...trendDates.map((d) =>
      trend.filter((t) => t.date === d).reduce((s, t) => s + t.cost, 0)
    ),
    0.01
  );

  return (
    <div className="p-3 space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Cost by Model</p>
        <div className="flex items-center gap-6">
          <svg width="120" height="120" viewBox="0 0 42 42" className="flex-shrink-0">
            {segments.map((seg, i) => (
              <circle
                key={i}
                cx="21" cy="21" r="15.9"
                fill="none"
                stroke={seg.color}
                strokeWidth="5"
                strokeDasharray={`${seg.pct} ${100 - seg.pct}`}
                strokeDashoffset={seg.offset}
              />
            ))}
            <text x="21" y="20" textAnchor="middle" fontSize="5" fill="#f4f4f5" fontWeight="700">
              ${totalCost.toFixed(2)}
            </text>
            <text x="21" y="25" textAnchor="middle" fontSize="3" fill="#71717a">
              total
            </text>
          </svg>
          <div className="space-y-2 flex-1">
            {segments.map((seg) => (
              <div key={seg.model} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-sm" style={{ background: seg.color }} />
                  <span className="text-[10px] text-zinc-200">{shortModelName(seg.model)}</span>
                </div>
                <span className="text-[10px] font-mono font-semibold" style={{ color: seg.color }}>
                  ${seg.cost.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Token Breakdown</p>
        <div className="space-y-3">
          {models.map((m, i) => {
            const total = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens;
            if (total === 0) return null;
            const parts = [
              { label: "Input", tokens: m.input_tokens, opacity: "1" },
              { label: "Output", tokens: m.output_tokens, opacity: "0.8" },
              { label: "Cache Read", tokens: m.cache_read_tokens, opacity: "0.4" },
              { label: "Cache Write", tokens: m.cache_write_tokens, opacity: "0.25" },
            ];
            return (
              <div key={m.model}>
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] text-zinc-200">{shortModelName(m.model)}</span>
                  <span className="text-[8px] text-zinc-500 font-mono">{formatTokens(total)} total</span>
                </div>
                <div className="h-2 flex rounded-full overflow-hidden gap-px">
                  {parts.map((part) => {
                    const pct = (part.tokens / total) * 100;
                    if (pct < 0.5) return null;
                    return (
                      <div
                        key={part.label}
                        style={{
                          width: `${pct}%`,
                          background: MODEL_COLORS[i % MODEL_COLORS.length],
                          opacity: part.opacity,
                        }}
                        title={`${part.label}: ${formatTokens(part.tokens)}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-3 mt-2 text-[7px] text-zinc-600">
          <span>Input</span>
          <span style={{ opacity: 0.8 }}>Output</span>
          <span style={{ opacity: 0.5 }}>Cache Read</span>
          <span style={{ opacity: 0.3 }}>Cache Write</span>
        </div>
      </div>

      {trendDates.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Usage Over Time</p>
          <div className="flex items-end gap-1" style={{ height: 80 }}>
            {trendDates.map((date) => {
              const dayData = trend.filter((t) => t.date === date);
              const isToday = date === new Date().toISOString().slice(0, 10);
              return (
                <div key={date} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full flex flex-col-reverse" style={{ height: 65 }}>
                    {trendModels.map((model, mi) => {
                      const entry = dayData.find((d) => d.model === model);
                      if (!entry || entry.cost === 0) return null;
                      const h = (entry.cost / maxDayCost) * 100;
                      return (
                        <div
                          key={model}
                          className="w-full rounded-sm"
                          style={{
                            height: `${h}%`,
                            background: MODEL_COLORS[mi % MODEL_COLORS.length],
                            minHeight: 2,
                          }}
                        />
                      );
                    })}
                  </div>
                  <span className={`text-[7px] ${isToday ? "text-violet-400" : "text-zinc-700"}`}>
                    {new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "narrow" })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {models.length === 0 && (
        <p className="text-center text-xs text-zinc-600 py-8">No model usage data in this period</p>
      )}
    </div>
  );
}
