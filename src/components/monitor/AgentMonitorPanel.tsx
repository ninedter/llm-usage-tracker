"use client";

import { useAgentMonitor } from "@/hooks/use-agent-monitor";
import { AgentCard } from "@/components/monitor/AgentCard";
import { useState, useEffect, useMemo } from "react";
import { useMonitorSettings, type MonitorFontSize } from "@/hooks/use-monitor-settings";
import { useNow } from "@/hooks/use-now";
import type { AgentEvent, AgentSession } from "@/types";

type ViewMode = "activity" | "agents" | "sessions";
type AgentFilter = "all" | "working" | "idle" | "completed" | "failed";

const EVENT_LABELS: Record<string, string> = {
  tool_call: "Tool Call",
  tool_result: "Result",
  subagent_start: "Subagent Started",
  subagent_stop: "Subagent Done",
  stop: "Paused",
  session_start: "Session Start",
  session_end: "Session End",
  notification: "Notification",
  compaction: "Compaction",
  error: "Error",
};

const EVENT_DOT_COLORS: Record<string, string> = {
  tool_call: "bg-blue-500",
  tool_result: "bg-cyan-500",
  subagent_start: "bg-violet-500",
  subagent_stop: "bg-violet-400",
  stop: "bg-amber-500",
  session_start: "bg-emerald-500",
  session_end: "bg-zinc-500",
  notification: "bg-sky-500",
  compaction: "bg-orange-500",
  error: "bg-red-500",
};

const FONT_SIZE_ICONS: Record<MonitorFontSize, string> = {
  xs: "XS",
  sm: "S",
  md: "M",
  lg: "L",
};

function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 5000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function formatDuration(start: number, end: number | null, now: number): string {
  const diff = (end || now) - start;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(diff / 1000)}s`;
}

// Activity feed item
function ActivityItem({ event, fc }: { event: AgentEvent; fc: ReturnType<typeof useMonitorSettings>["fontClasses"] }) {
  const now = useNow();
  const dotColor = EVENT_DOT_COLORS[event.event_type] || "bg-zinc-500";
  const label = EVENT_LABELS[event.event_type] || event.event_type;

  return (
    <div className="flex items-start gap-2.5 py-1.5 px-1 group hover:bg-zinc-800/30 rounded transition-colors">
      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`${fc.micro} text-zinc-500`}>{formatRelativeTime(event.timestamp, now)}</span>
          <span className={`${fc.micro} font-medium text-zinc-400`}>{label}</span>
          {event.tool_name && (
            <span className={`${fc.micro} text-blue-400 font-mono`}>{event.tool_name}</span>
          )}
        </div>
        {event.summary && (
          <p className={`${fc.micro} text-zinc-600 truncate mt-0.5`}>{event.summary}</p>
        )}
      </div>
    </div>
  );
}

// Session card
function SessionCard({ session, fc }: { session: AgentSession; fc: ReturnType<typeof useMonitorSettings>["fontClasses"] }) {
  const now = useNow();
  const isActive = session.status === "active";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${isActive ? "border-emerald-500/20 bg-emerald-950/5" : "border-zinc-800 bg-zinc-900/30"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`} />
          <span className={`${fc.base} font-medium text-zinc-200 truncate`}>
            {session.project || session.session_id.substring(0, 8)}
          </span>
          <span className={`${fc.tiny} text-zinc-600 font-mono flex-shrink-0`}>
            {session.entrypoint === "claude-desktop" ? "Desktop" : session.entrypoint === "cli" ? "Terminal" : session.entrypoint || "Agent"}
          </span>
        </div>
        <span className={`${fc.micro} text-zinc-600 font-mono flex-shrink-0`}>
          {formatDuration(session.first_started, isActive ? null : session.last_activity, now)}
        </span>
      </div>
      <div className={`mt-1.5 flex items-center gap-3 ${fc.micro}`}>
        <span className="text-zinc-500">
          <span className="text-zinc-400 font-medium">{session.agent_count}</span> agent{session.agent_count !== 1 ? "s" : ""}
        </span>
        {session.working_count > 0 && (
          <span className="text-emerald-500">
            <span className="font-medium">{session.working_count}</span> working
          </span>
        )}
        {session.subagent_count > 0 && (
          <span className="text-violet-400">
            <span className="font-medium">{session.subagent_count}</span> sub
          </span>
        )}
        <span className="text-zinc-600">
          {session.event_count} events
        </span>
      </div>
    </div>
  );
}

export function AgentMonitorPanel() {
  const {
    agents,
    workingAgents,
    idleAgents,
    sessions,
    events,
    recentActivity,
    stats,
    connected,
    fetchAgentEvents,
    refetchAll,
    reset,
  } = useAgentMonitor();

  const { fontSize, setFontSize, fontClasses: fc, fontSizeOptions } = useMonitorSettings();

  const [viewMode, setViewMode] = useState<ViewMode>("activity");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFontMenu, setShowFontMenu] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleClearData = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/monitor/clear", { method: "DELETE" });
      if (res.ok) {
        reset();
        refetchAll();
        setShowClearConfirm(false);
      }
    } catch { /* ignore */ }
    setClearing(false);
  };

  const failedCount = agents.filter((a) => a.status === "failed").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;

  // Filter agents — memoized with debounced search
  const filteredAgents = useMemo(() => {
    let list = agents;
    if (agentFilter === "working") list = workingAgents;
    else if (agentFilter === "idle") list = idleAgents;
    else if (agentFilter === "completed") list = list.filter((a) => a.status === "completed");
    else if (agentFilter === "failed") list = list.filter((a) => a.status === "failed");

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (a) =>
          a.type.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.subagent_type || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [agents, workingAgents, idleAgents, agentFilter, debouncedSearch]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-zinc-800/80 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h2 className={`${fc.heading} font-semibold text-zinc-100`}>Agent Monitor</h2>
            <div className="flex items-center gap-1 rounded-full bg-zinc-900 px-2 py-0.5">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
              <span className={`${fc.micro} text-zinc-500`}>{connected ? "Live" : "Offline"}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Font size toggle */}
            <div className="relative">
              <button
                onClick={() => setShowFontMenu(!showFontMenu)}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                title="Font size"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
                </svg>
              </button>
              {showFontMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowFontMenu(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl min-w-[120px]">
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Font Size</p>
                    {fontSizeOptions.map(({ value, label }) => (
                      <button
                        key={value}
                        onClick={() => { setFontSize(value); setShowFontMenu(false); }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                          fontSize === value
                            ? "bg-zinc-700 text-zinc-100"
                            : "text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200"
                        }`}
                      >
                        <span className="w-5 text-center font-mono text-[10px] text-zinc-500">{FONT_SIZE_ICONS[value]}</span>
                        {label}
                        {fontSize === value && (
                          <svg className="ml-auto h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Clear data */}
            <div className="relative">
              <button
                onClick={() => setShowClearConfirm(!showClearConfirm)}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 transition-colors"
                title="Clear all data"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              {showClearConfirm && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowClearConfirm(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 p-3 shadow-xl min-w-[200px]">
                    <p className="text-xs font-medium text-zinc-200 mb-1">Clear all monitor data?</p>
                    <p className="text-[10px] text-zinc-500 mb-3">This will delete all sessions, agents, and events. This cannot be undone.</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleClearData}
                        disabled={clearing}
                        className="rounded-md bg-red-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                      >
                        {clearing ? "Clearing..." : "Clear All"}
                      </button>
                      <button
                        onClick={() => setShowClearConfirm(false)}
                        className="rounded-md px-3 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            {/* Refresh */}
            <button
              onClick={refetchAll}
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
              title="Refresh"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="mt-2 grid grid-cols-4 gap-2">
          <div className="rounded-md bg-zinc-900 px-2 py-1.5 text-center">
            <p className={`${fc.label} font-semibold text-zinc-200`}>{stats?.active_sessions ?? 0}</p>
            <p className={`${fc.tiny} text-zinc-600`}>Active</p>
          </div>
          <div className="rounded-md bg-zinc-900 px-2 py-1.5 text-center">
            <p className={`${fc.label} font-semibold text-emerald-400`}>{workingAgents.length}</p>
            <p className={`${fc.tiny} text-zinc-600`}>Working</p>
          </div>
          <div className="rounded-md bg-zinc-900 px-2 py-1.5 text-center">
            <p className={`${fc.label} font-semibold text-zinc-400`}>{stats?.total_events ?? 0}</p>
            <p className={`${fc.tiny} text-zinc-600`}>Events</p>
          </div>
          <div className="rounded-md bg-zinc-900 px-2 py-1.5 text-center">
            <p className={`${fc.label} font-semibold text-zinc-400`}>{agents.length}</p>
            <p className={`${fc.tiny} text-zinc-600`}>Agents</p>
          </div>
        </div>

        {/* View mode tabs */}
        <div className="mt-2 flex items-center gap-1">
          {(["activity", "agents", "sessions"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-2.5 py-1 ${fc.micro} font-medium transition-colors ${
                viewMode === mode
                  ? "bg-zinc-800 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}

          {/* Search — only for agents view */}
          {viewMode === "agents" && (
            <div className="relative flex-1 ml-1">
              <svg className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`w-full rounded-md border border-zinc-800 bg-zinc-900 py-1 pl-7 pr-2 ${fc.micro} text-zinc-300 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none`}
              />
            </div>
          )}
        </div>

        {/* Agent filter tabs — only in agents view */}
        {viewMode === "agents" && (
          <div className="mt-1.5 flex items-center gap-0.5">
            {([
              { key: "all", label: "All", count: agents.length },
              { key: "working", label: "Working", count: workingAgents.length },
              { key: "idle", label: "Idle", count: idleAgents.length },
              { key: "completed", label: "Done", count: completedCount },
              { key: "failed", label: "Failed", count: failedCount },
            ] as { key: AgentFilter; label: string; count: number }[]).map(({ key, label, count }) => (
              count > 0 || key === "all" ? (
                <button
                  key={key}
                  onClick={() => setAgentFilter(key)}
                  className={`rounded px-1.5 py-0.5 ${fc.tiny} font-medium transition-colors ${
                    agentFilter === key
                      ? "bg-zinc-700 text-zinc-200"
                      : "text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  {label} {count > 0 && <span className="text-zinc-500">({count})</span>}
                </button>
              ) : null
            ))}
          </div>
        )}
      </div>

      {/* Content area — scrollable */}
      <div className="flex-1 overflow-y-auto">
        {/* Activity Feed View */}
        {viewMode === "activity" && (
          <div className="px-3 py-2">
            {recentActivity.length === 0 ? (
              <EmptyState fc={fc} />
            ) : (
              <div className="space-y-0.5">
                {recentActivity.slice(0, 50).map((event) => (
                  <ActivityItem key={event.id} event={event} fc={fc} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Agents View */}
        {viewMode === "agents" && (
          <div className="p-3 space-y-2">
            {filteredAgents.length === 0 ? (
              <EmptyState fc={fc} />
            ) : (
              filteredAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  events={(events.get(agent.id) || []).slice(0, 200)}
                  onExpandEvents={fetchAgentEvents}
                  fontSize={fontSize}
                />
              ))
            )}
          </div>
        )}

        {/* Sessions View */}
        {viewMode === "sessions" && (
          <div className="p-3 space-y-2">
            {sessions.length === 0 ? (
              <EmptyState fc={fc} />
            ) : (
              sessions.map((session) => (
                <SessionCard key={session.session_id} session={session} fc={fc} />
              ))
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-zinc-800/80 px-3 py-1.5">
        <div className="flex items-center justify-between">
          <p className={`${fc.tiny} text-zinc-600`}>
            {connected ? "SSE connected" : "Reconnecting..."} · {stats?.events_today ?? 0} events today
          </p>
          {stats && stats.total_sessions > 0 && (
            <p className={`${fc.tiny} text-zinc-600`}>
              {stats.total_sessions} session{stats.total_sessions !== 1 ? "s" : ""} total
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ fc }: { fc: ReturnType<typeof useMonitorSettings>["fontClasses"] }) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <svg className="h-8 w-8 text-zinc-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
      <p className={`mt-2 ${fc.small} text-zinc-600`}>No activity yet</p>
      <p className={`mt-0.5 ${fc.tiny} text-zinc-700`}>
        Activity appears when Claude Code hooks are active
      </p>
    </div>
  );
}
