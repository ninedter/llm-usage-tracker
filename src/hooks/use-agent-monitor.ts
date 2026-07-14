"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import useSWR from "swr";
import type { ProviderFilterValue } from "@/components/ui/ProviderFilter";
import type { ApiResponse, AgentRecord, AgentEvent, AgentSession, MonitorStats } from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

const STATUS_PRIORITY: Record<string, number> = {
  working: 0,
  idle: 1,
  failed: 2,
  completed: 3,
  cancelled: 4,
};

export function useAgentMonitor() {
  const [agents, setAgents] = useState<Map<string, AgentRecord>>(new Map());
  const [events, setEvents] = useState<Map<string, AgentEvent[]>>(new Map());
  const [recentActivity, setRecentActivity] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState<ProviderFilterValue>("all");
  const eventSourceRef = useRef<EventSource | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pq = provider === "all" ? "" : `provider=${provider}`;

  // Switching provider must drop the merge-only caches, or agents from the tab
  // you just left would linger (SWR onSuccess and SSE both only ever add).
  useEffect(() => {
    setAgents(new Map());
    setEvents(new Map());
    setRecentActivity([]);
  }, [provider]);

  // Initial fetch of all agents — each successful fetch seeds the agents map
  const { mutate: refetchAgents } = useSWR<AgentRecord[]>(
    `/api/monitor/agents?limit=200${pq ? `&${pq}` : ""}`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 30_000,
      onSuccess: (fetched) => {
        setAgents((prev) => {
          const next = new Map(prev);
          for (const a of fetched) {
            next.set(a.id, a);
          }
          return next;
        });
      },
    }
  );

  // Fetch sessions
  const { data: sessionsData, mutate: refetchSessions } = useSWR<AgentSession[]>(
    `/api/monitor/sessions${pq ? `?${pq}` : ""}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 }
  );

  // Fetch stats
  const { data: stats, mutate: refetchStats } = useSWR<MonitorStats>(
    `/api/monitor/stats${pq ? `?${pq}` : ""}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 }
  );

  // Stable refs for SSE callback to avoid re-subscribing
  const refetchSessionsRef = useRef(refetchSessions);
  const refetchStatsRef = useRef(refetchStats);
  useEffect(() => { refetchSessionsRef.current = refetchSessions; }, [refetchSessions]);
  useEffect(() => { refetchStatsRef.current = refetchStats; }, [refetchStats]);

  // SSE connection for real-time updates — stable deps, never re-subscribes
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
          setRecentActivity((prev) => {
            if (prev.length >= 100) {
              return [event, ...prev.slice(0, 99)];
            }
            return [event, ...prev];
          });
        }

        if (msg.type === "session_created" || msg.type === "session_updated" || msg.type === "stats_updated") {
          // Debounced refetch — coalesce rapid SSE events into a single fetch
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(() => {
            refetchSessionsRef.current();
            refetchStatsRef.current();
            debounceTimerRef.current = null;
          }, 500);
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
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []); // Empty deps — single SSE connection for the lifetime of the component

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

  // Memoized computed values — only recalculate when agents map changes.
  // The provider check is a safety net: SSE pushes agents of every provider
  // into the map regardless of what the fetches were scoped to.
  const agentList = useMemo(() =>
    Array.from(agents.values())
      .filter((a) => a.status !== "archived")
      .filter((a) => provider === "all" || a.provider === provider)
      .sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 3;
      const pb = STATUS_PRIORITY[b.status] ?? 3;
      if (pa !== pb) return pa - pb;
      return b.started_at - a.started_at;
    }),
    [agents, provider]
  );

  const workingAgents = useMemo(() => agentList.filter((a) => a.status === "working"), [agentList]);
  const idleAgents = useMemo(() => agentList.filter((a) => a.status === "idle"), [agentList]);
  const completedAgents = useMemo(() => agentList.filter((a) => a.status === "completed" || a.status === "failed"), [agentList]);
  const mainAgents = useMemo(() => agentList.filter((a) => a.type === "main"), [agentList]);
  const subagents = useMemo(() => agentList.filter((a) => a.type === "subagent"), [agentList]);

  // Group by session
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, AgentRecord[]>();
    for (const a of agentList) {
      const list = groups.get(a.session_id) || [];
      list.push(a);
      groups.set(a.session_id, list);
    }
    return groups;
  }, [agentList]);

  const refetchAll = useCallback(() => {
    refetchAgents();
    refetchSessions();
    refetchStats();
  }, [refetchAgents, refetchSessions, refetchStats]);

  // Drop all client-held monitor state. agents/events/recentActivity are
  // merge-only (SWR onSuccess and SSE both only add), so after a destructive
  // server op like Clear All a refetch alone leaves stale entries behind.
  const reset = useCallback(() => {
    setAgents(new Map());
    setEvents(new Map());
    setRecentActivity([]);
  }, []);

  return {
    provider,
    setProvider,
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
    reset,
  };
}
