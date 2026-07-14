"use client";

import type { ToolAnalytics } from "@/types";

interface ToolsPanelProps {
  data: ToolAnalytics | null;
  loading: boolean;
}

const TOOL_COLORS: Record<string, string> = {
  Read: "bg-blue-500",
  Edit: "bg-violet-500",
  Bash: "bg-emerald-500",
  Grep: "bg-amber-500",
  Write: "bg-pink-500",
  Glob: "bg-cyan-500",
  Agent: "bg-orange-500",
};

function getToolColor(name: string): string {
  return TOOL_COLORS[name] || "bg-zinc-500";
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

// MCP tool names like mcp__Claude_Browser__navigate are too long for a label
// column — display the tool part, falling back to server:tool on collisions.
function buildDisplayNames(names: string[]): Map<string, string> {
  const shortCounts = new Map<string, number>();
  for (const n of names) {
    const s = parseMcpName(n)?.tool ?? n;
    shortCounts.set(s, (shortCounts.get(s) || 0) + 1);
  }
  const display = new Map<string, string>();
  for (const n of names) {
    const p = parseMcpName(n);
    const s = p?.tool ?? n;
    display.set(n, p && (shortCounts.get(s) || 0) > 1 ? `${p.server}:${p.tool}` : s);
  }
  return display;
}

export function ToolsPanel({ data, loading }: ToolsPanelProps) {
  if (loading || !data) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-6 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  const { tools, timeline } = data;
  const maxCount = Math.max(...tools.map((t) => t.call_count), 1);
  const displayNames = buildDisplayNames(tools.map((t) => t.tool_name));
  const nameOf = (full: string) => displayNames.get(full) ?? full;

  const toolNames = tools.map((t) => t.tool_name);
  const timelineByTool = new Map<string, typeof timeline>();
  for (const name of toolNames) {
    timelineByTool.set(name, timeline.filter((p) => p.tool_name === name));
  }
  const minTs = timeline.length > 0 ? Math.min(...timeline.map((p) => p.timestamp)) : 0;
  const maxTs = timeline.length > 0 ? Math.max(...timeline.map((p) => p.timestamp)) : 1;
  const tsRange = maxTs - minTs || 1;

  return (
    <div className="p-3 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Most Used Tools</p>
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div key={tool.tool_name} className="flex items-center gap-2">
                <span
                  className="text-sm text-zinc-400 font-mono w-28 shrink-0 text-right truncate"
                  title={tool.tool_name}
                >
                  {nameOf(tool.tool_name)}
                </span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${getToolColor(tool.tool_name)}`}
                    style={{ width: `${(tool.call_count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="text-sm text-zinc-600 font-mono w-8 shrink-0 text-right">{tool.call_count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Success / Failure Rate</p>
          <div className="space-y-1.5">
            {tools.map((tool) => (
              <div key={tool.tool_name} className="flex items-center gap-2">
                <span
                  className="text-sm text-zinc-400 font-mono w-28 shrink-0 text-right truncate"
                  title={tool.tool_name}
                >
                  {nameOf(tool.tool_name)}
                </span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${tool.success_rate}%` }} />
                  <div className="h-full bg-red-500" style={{ width: `${100 - tool.success_rate}%` }} />
                </div>
                <span className={`text-sm font-mono w-10 shrink-0 text-right ${tool.success_rate >= 95 ? "text-emerald-400" : tool.success_rate >= 80 ? "text-amber-400" : "text-red-400"}`}>
                  {tool.success_rate}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {timeline.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tool Call Timeline</p>
            <p className="text-xs text-zinc-600">
              {new Date(minTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
              {" — "}
              {new Date(maxTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <div className="space-y-1">
            {toolNames.slice(0, 8).map((name) => {
              const points = timelineByTool.get(name) || [];
              return (
                <div key={name} className="flex items-center gap-2 h-4">
                  <span
                    className="text-xs text-zinc-500 font-mono w-24 shrink-0 text-right truncate"
                    title={name}
                  >
                    {nameOf(name)}
                  </span>
                  <div className="flex-1 h-3.5 bg-zinc-900 rounded relative overflow-hidden">
                    {points.map((p, i) => {
                      const left = ((p.timestamp - minTs) / tsRange) * 100;
                      return (
                        <div
                          key={i}
                          className={`absolute top-0 h-full rounded-sm ${p.success ? getToolColor(name) : "bg-red-500"}`}
                          style={{
                            left: `${left}%`,
                            width: Math.max(2, (p.duration_ms / tsRange) * 100) + "px",
                            opacity: 0.8,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-3 mt-2 text-xs text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-sm bg-emerald-500" /> Success
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-sm bg-red-500" /> Failed
            </span>
          </div>
        </div>
      )}

      {tools.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Average Duration per Tool</p>
          <div className="grid grid-cols-4 gap-2">
            {tools
              .filter((t) => t.avg_duration_ms > 0)
              .sort((a, b) => b.avg_duration_ms - a.avg_duration_ms)
              .slice(0, 8)
              .map((tool) => (
                <div key={tool.tool_name} className="text-center rounded-lg bg-zinc-900 p-2 min-w-0">
                  <p className="text-xs text-zinc-500 truncate" title={tool.tool_name}>
                    {nameOf(tool.tool_name)}
                  </p>
                  <p className={`text-sm font-bold mt-0.5 ${tool.avg_duration_ms > 5000 ? "text-amber-400" : "text-zinc-300"}`}>
                    {tool.avg_duration_ms >= 1000
                      ? `${(tool.avg_duration_ms / 1000).toFixed(1)}s`
                      : `${tool.avg_duration_ms}ms`}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
