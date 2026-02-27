"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import useSWR from "swr";
import type { ApiResponse, AgentRecord, AgentEvent, AgentSession, MonitorStats } from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

export function useAgentMonitor() {
  const [agents, setAgents] = useState<Map<string, AgentRecord>>(new Map());
  const [events, setEvents] = useState<Map<string, AgentEvent[]>>(new Map());
  const [recentActivity, setRecentActivity] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Initial fetch of all agents
  const { data: initialAgents, mutate: refetchAgents } = useSWR<AgentRecord[]>(
    "/api/monitor/agents?limit=200",
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 30_000 }
  );

  // Fetch sessions
  const { data: sessionsData, mutate: refetchSessions } = useSWR<AgentSession[]>(
    "/api/monitor/sessions",
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 30_000 }
  );

  // Fetch stats
  const { data: stats, mutate: refetchStats } = useSWR<MonitorStats>(
    "/api/monitor/stats",
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 10_000 }
  );

  // Seed the agents map from SWR data
  useEffect(() => {
    if (initialAgents) {
      setAgents((prev) => {
        const next = new Map(prev);
        for (const a of initialAgents) {
          next.set(a.id, a);
        }
        return next;
      });
    }
  }, [initialAgents]);

  // SSE connection for real-time updates
  useEffect(() => {
    const es = new EventSource("/api/monitor/stream");
    eventSourceRef.current = es;

    es.addEventListener("connected", () => setConnected(true));

    es.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data) as {
          type: string;
          data: AgentRecord | AgentEvent;
        };

        if (msg.type === "agent_created" || msg.type === "agent_updated") {
          const agent = msg.data as AgentRecord;
          setAgents((prev) => new Map(prev).set(agent.id, agent));
        }

        if (msg.type === "event_created") {
          const event = msg.data as AgentEvent;
          // Add to agent-specific events
          setEvents((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.agent_id) || [];
            next.set(event.agent_id, [...existing, event]);
            return next;
          });
          // Add to recent activity feed (keep last 100)
          setRecentActivity((prev) => [event, ...prev].slice(0, 100));
        }

        if (msg.type === "session_created" || msg.type === "session_updated" || msg.type === "stats_updated") {
          // Refresh sessions and stats from server
          refetchSessions();
          refetchStats();
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("ping", () => {
      // keepalive
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [refetchSessions, refetchStats]);

  // Fetch events for a specific agent
  const fetchAgentEvents = useCallback(async (agentId: string) => {
    try {
      const res = await fetch(`/api/monitor/events/${agentId}`);
      const json: ApiResponse<AgentEvent[]> = await res.json();
      if (json.success && json.data) {
        setEvents((prev) => new Map(prev).set(agentId, json.data!));
      }
    } catch {
      // ignore
    }
  }, []);

  // Computed values
  // Sort: idle (waiting for input) first, then working, then inactive
  const STATUS_PRIORITY: Record<string, number> = {
    idle: 0,
    working: 1,
    failed: 2,
    completed: 3,
    cancelled: 4,
  };
  const agentList = Array.from(agents.values()).sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 3;
    const pb = STATUS_PRIORITY[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.started_at - a.started_at;
  });

  const workingAgents = agentList.filter((a) => a.status === "working");
  const idleAgents = agentList.filter((a) => a.status === "idle");
  const completedAgents = agentList.filter((a) => a.status === "completed" || a.status === "failed");
  const mainAgents = agentList.filter((a) => a.type === "main");
  const subagents = agentList.filter((a) => a.type === "subagent");

  // Group by session
  const sessionGroups = new Map<string, AgentRecord[]>();
  for (const a of agentList) {
    const list = sessionGroups.get(a.session_id) || [];
    list.push(a);
    sessionGroups.set(a.session_id, list);
  }

  const refetchAll = useCallback(() => {
    refetchAgents();
    refetchSessions();
    refetchStats();
  }, [refetchAgents, refetchSessions, refetchStats]);

  return {
    agents: agentList,
    workingAgents,
    idleAgents,
    completedAgents,
    mainAgents,
    subagents,
    sessions: sessionsData || [],
    sessionGroups,
    events,
    recentActivity,
    stats: stats || null,
    connected,
    fetchAgentEvents,
    refetchAll,
  };
}
