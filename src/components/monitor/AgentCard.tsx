"use client";

import { useState } from "react";
import type { AgentRecord, AgentEvent } from "@/types";
import { FONT_CLASSES, type MonitorFontSize } from "@/hooks/use-monitor-settings";
import { useNow } from "@/hooks/use-now";

interface AgentCardProps {
  agent: AgentRecord;
  events: AgentEvent[];
  onExpandEvents: (agentId: string) => void;
  compact?: boolean;
  fontSize?: MonitorFontSize;
}

const STATUS_CONFIG: Record<string, { dot: string; bg: string; text: string; label: string }> = {
  working: { dot: "bg-emerald-500 animate-pulse", bg: "border-emerald-500/20 bg-emerald-950/5", text: "text-emerald-400", label: "Working" },
  idle: { dot: "bg-amber-400", bg: "border-amber-500/20 bg-amber-950/5", text: "text-amber-400", label: "Idle" },
  completed: { dot: "bg-zinc-500", bg: "border-zinc-700/50 bg-zinc-900/30", text: "text-zinc-500", label: "Completed" },
  failed: { dot: "bg-red-500", bg: "border-red-500/20 bg-red-950/5", text: "text-red-400", label: "Failed" },
  cancelled: { dot: "bg-zinc-600", bg: "border-zinc-700/50 bg-zinc-900/30", text: "text-zinc-600", label: "Cancelled" },
};

const EVENT_ICONS: Record<string, string> = {
  tool_call: "T",
  tool_result: "R",
  subagent_start: "S",
  subagent_stop: "S",
  stop: "P",
  session_start: "S",
  session_end: "E",
  notification: "N",
  compaction: "C",
  error: "!",
};

const EVENT_COLORS: Record<string, string> = {
  tool_call: "text-blue-400 bg-blue-500/10",
  tool_result: "text-cyan-400 bg-cyan-500/10",
  subagent_start: "text-violet-400 bg-violet-500/10",
  subagent_stop: "text-violet-400 bg-violet-500/10",
  stop: "text-amber-400 bg-amber-500/10",
  session_start: "text-emerald-400 bg-emerald-500/10",
  session_end: "text-zinc-400 bg-zinc-500/10",
  notification: "text-sky-400 bg-sky-500/10",
  compaction: "text-orange-400 bg-orange-500/10",
  error: "text-red-400 bg-red-500/10",
  content: "text-zinc-400 bg-zinc-500/10",
  status_change: "text-amber-400 bg-amber-500/10",
};

export function AgentCard({ agent, events, onExpandEvents, compact, fontSize = "sm" }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  // All cards share one interval via the useNow() store — no per-card timers
  const now = useNow();

  const fc = FONT_CLASSES[fontSize];
  const status = STATUS_CONFIG[agent.status] || STATUS_CONFIG.working;

  const end = agent.ended_at || now;
  const diff = Math.max(0, end - agent.started_at);
  const s = Math.floor(diff / 1000) % 60;
  const m = Math.floor(diff / 60000) % 60;
  const h = Math.floor(diff / 3600000);
  const elapsed = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && events.length === 0) {
      onExpandEvents(agent.id);
    }
  };

  // Derived data
  const latestToolCall = [...events].reverse().find((e) => e.event_type === "tool_call");
  const toolCalls = events.filter((e) => e.event_type === "tool_call");
  const allFiles = new Set<string>();
  for (const e of events) {
    if (e.files_affected) {
      try { (JSON.parse(e.files_affected) as string[]).forEach((f) => allFiles.add(f)); } catch { /* ignore */ }
    }
  }

  const isSubagent = agent.type === "subagent";

  return (
    <div className={`group overflow-hidden rounded-lg border transition-all duration-200 ${status.bg} ${expanded ? "shadow-lg" : "hover:shadow-md"}`}>
      {/* Header */}
      <button
        onClick={handleToggleExpand}
        className={`flex w-full items-center gap-3 text-left ${compact ? "px-3 py-2" : "px-4 py-3"}`}
      >
        {/* Status indicator */}
        <div className="flex-shrink-0">
          <span className={`block h-2 w-2 rounded-full ${status.dot}`} />
        </div>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`${compact ? fc.base : fc.label} font-medium text-zinc-100 truncate`}>
              {agent.description || agent.type}
            </span>
            {isSubagent && (
              <span className={`flex-shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 ${fc.tiny} font-medium text-violet-400`}>
                {agent.subagent_type || "subagent"}
              </span>
            )}
            {!isSubagent && (
              <span className={`flex-shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 ${fc.tiny} font-medium text-zinc-500`}>
                {agent.type}
              </span>
            )}
          </div>

          {/* Current activity line */}
          {agent.status === "working" && agent.current_tool && (
            <p className={`mt-0.5 ${fc.small} text-zinc-500 truncate`}>
              <span className="text-blue-400">{agent.current_tool}</span>
              {latestToolCall?.summary && (
                <span className="text-zinc-600"> — {latestToolCall.summary}</span>
              )}
            </p>
          )}
          {agent.status === "working" && !agent.current_tool && latestToolCall && (
            <p className={`mt-0.5 ${fc.small} text-zinc-600 truncate`}>
              Last: {latestToolCall.tool_name} — {latestToolCall.summary}
            </p>
          )}
          {agent.status === "idle" && (
            <p className={`mt-0.5 ${fc.small} text-amber-500/70 truncate`}>
              Waiting for input...
            </p>
          )}
        </div>

        {/* Right side stats */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {toolCalls.length > 0 && (
            <span className={`rounded bg-zinc-800/80 px-1.5 py-0.5 ${fc.tiny} text-zinc-500 font-mono`}>
              {toolCalls.length}
            </span>
          )}
          {allFiles.size > 0 && (
            <span className={`rounded bg-zinc-800/80 px-1.5 py-0.5 ${fc.tiny} text-zinc-500 font-mono`}>
              {allFiles.size}f
            </span>
          )}
          <span className={`${fc.small} font-mono ${status.text}`}>{elapsed}</span>
          <svg
            className={`h-3.5 w-3.5 text-zinc-600 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-zinc-800/50 px-4 pb-3">
          {/* Currently running tool */}
          {agent.status === "working" && latestToolCall && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-zinc-900/60 p-2.5">
              <span className="mt-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 flex-shrink-0" />
              <div className="min-w-0">
                <span className={`${fc.micro} font-semibold uppercase tracking-wider text-emerald-500`}>Active</span>
                <p className={`${fc.base} text-zinc-300 font-mono mt-0.5`}>
                  <span className="text-blue-300">{latestToolCall.tool_name}</span>
                  {latestToolCall.summary && (
                    <span className="text-zinc-500"> — {latestToolCall.summary}</span>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Files affected */}
          {allFiles.size > 0 && (
            <div className="mt-2.5">
              <p className={`mb-1 ${fc.tiny} font-semibold uppercase tracking-wider text-zinc-600`}>
                Files ({allFiles.size})
              </p>
              <div className="flex flex-wrap gap-1">
                {Array.from(allFiles).slice(0, 8).map((f) => (
                  <span key={f} className={`rounded bg-zinc-800/60 px-1.5 py-0.5 ${fc.micro} text-zinc-500 font-mono`}>
                    {f.split("/").pop()}
                  </span>
                ))}
                {allFiles.size > 8 && (
                  <span className={`${fc.micro} text-zinc-600`}>+{allFiles.size - 8}</span>
                )}
              </div>
            </div>
          )}

          {/* Session ID */}
          <div className={`mt-2.5 flex items-center gap-2 ${fc.micro} text-zinc-600`}>
            <span className="font-mono">{agent.id.substring(0, 8)}</span>
            <span>·</span>
            <span>{new Date(agent.started_at).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}</span>
            {agent.ended_at && (
              <>
                <span>→</span>
                <span>{new Date(agent.ended_at).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}</span>
              </>
            )}
          </div>

          {/* Timeline toggle */}
          <button
            onClick={() => {
              setShowTimeline(!showTimeline);
              if (!showTimeline && events.length === 0) onExpandEvents(agent.id);
            }}
            className={`mt-2.5 flex items-center gap-1 ${fc.micro} font-medium text-zinc-600 hover:text-zinc-400 transition-colors`}
          >
            <svg
              className={`h-3 w-3 transition-transform ${showTimeline ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {events.length} events
          </button>

          {/* Event timeline */}
          {showTimeline && (
            <div className="mt-2 ml-1 border-l border-zinc-800 pl-3 max-h-72 overflow-auto space-y-0.5">
              {events.length === 0 ? (
                <p className={`${fc.micro} text-zinc-700 italic py-2`}>Loading events...</p>
              ) : (
                events.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 py-1">
                    <span className={`flex-shrink-0 mt-0.5 w-4 h-4 rounded text-center ${fc.tiny} font-bold leading-4 ${EVENT_COLORS[e.event_type] || "text-zinc-500 bg-zinc-800"}`}>
                      {EVENT_ICONS[e.event_type] || "·"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`${fc.micro} font-mono text-zinc-600`}>
                          {formatTime(e.timestamp)}
                        </span>
                        {e.tool_name && (
                          <span className={`${fc.micro} text-blue-400 font-mono font-medium`}>
                            {e.tool_name}
                          </span>
                        )}
                      </div>
                      {e.summary && (
                        <p className={`${fc.micro} text-zinc-500 truncate`}>{e.summary}</p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
