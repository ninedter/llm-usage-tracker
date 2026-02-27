"use client";

import Link from "next/link";
import { useAgentMonitor } from "@/hooks/use-agent-monitor";
import { AgentCard } from "@/components/monitor/AgentCard";
import { useMonitorSettings } from "@/hooks/use-monitor-settings";
import { useState } from "react";

type ViewMode = "all" | "working" | "completed" | "failed";
type GroupMode = "flat" | "session";

export default function MonitorPage() {
  const {
    agents,
    workingAgents,
    completedAgents,
    sessionGroups,
    events,
    stats,
    connected,
    fetchAgentEvents,
    refetchAll,
  } = useAgentMonitor();

  const { fontSize } = useMonitorSettings();
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAgents = (() => {
    let list = agents;
    if (viewMode === "working") list = workingAgents;
    else if (viewMode === "completed") list = list.filter((a) => a.status === "completed");
    else if (viewMode === "failed") list = list.filter((a) => a.status === "failed");

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          a.type.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q)
      );
    }
    return list;
  })();

  const failedCount = agents.filter((a) => a.status === "failed").length;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-8">
      <div className="titlebar-drag mb-6 flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Agent Monitor</h1>
          <p className="mt-1 text-sm text-zinc-400">Real-time observation of Claude Code agent activity.</p>
        </div>
        <div className="titlebar-no-drag flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
            <span className="text-xs text-zinc-500">{connected ? "Live" : "Disconnected"}</span>
          </div>
          <button onClick={refetchAll} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            Refresh
          </button>
          <Link href="/" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
            Dashboard
          </Link>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Agents" value={agents.length} />
        <StatCard label="Working" value={workingAgents.length} color="emerald" />
        <StatCard label="Completed" value={completedAgents.length} color="zinc" />
        <StatCard label="Failed" value={failedCount} color={failedCount > 0 ? "red" : "zinc"} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-zinc-700 bg-zinc-800 p-0.5">
          {(["all", "working", "completed", "failed"] as ViewMode[]).map((mode) => (
            <button key={mode} onClick={() => setViewMode(mode)} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${viewMode === mode ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-zinc-700 bg-zinc-800 p-0.5">
          <button onClick={() => setGroupMode("flat")} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${groupMode === "flat" ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>Flat</button>
          <button onClick={() => setGroupMode("session")} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${groupMode === "session" ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>By Session</button>
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input type="text" placeholder="Search agents..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-1.5 pl-9 pr-3 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none" />
        </div>
      </div>

      {groupMode === "flat" ? (
        <div className="space-y-3">
          {filteredAgents.length === 0 ? <EmptyState /> : filteredAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} events={events.get(agent.id) || []} onExpandEvents={fetchAgentEvents} fontSize={fontSize} />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(sessionGroups.entries()).map(([sessionId, sessionAgents]) => {
            const filtered = sessionAgents.filter((a) => filteredAgents.includes(a));
            if (filtered.length === 0) return null;
            const working = filtered.some((a) => a.status === "working");
            return (
              <div key={sessionId}>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${working ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`} />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Session {sessionId.slice(0, 8)}</h3>
                  <span className="text-[10px] text-zinc-600">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="space-y-2 pl-4 border-l border-zinc-800">
                  {filtered.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} events={events.get(agent.id) || []} onExpandEvents={fetchAgentEvents} fontSize={fontSize} />
                  ))}
                </div>
              </div>
            );
          })}
          {filteredAgents.length === 0 && <EmptyState />}
        </div>
      )}

      <div className="mt-8 text-center text-xs text-zinc-600">
        {connected ? "Connected via SSE" : "Reconnecting..."} · {stats?.total_events ?? 0} events tracked
      </div>
    </div>
  );
}

function StatCard({ label, value, color = "zinc" }: { label: string; value: number; color?: string }) {
  const colors: Record<string, string> = { emerald: "text-emerald-400", red: "text-red-400", zinc: "text-zinc-100" };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colors[color] || colors.zinc}`}>{value}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/50 py-16">
      <svg className="h-12 w-12 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
      <p className="mt-4 text-sm text-zinc-500">No agents detected yet.</p>
      <p className="mt-1 text-xs text-zinc-600">Agent activity will appear here once Claude Code hooks are configured.</p>
    </div>
  );
}
