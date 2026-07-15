"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import useSWR from "swr";
import { mergeRecentActivity, ACTIVITY_FEED_CAP } from "@/lib/activity-merge";
import type { ProviderFilterValue } from "@/components/ui/ProviderFilter";
import type { ApiResponse, AgentRecord, AgentEvent, AgentSession, MonitorStats } from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

const MAX_AGENT_EVENTS = 200;

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
  const [provider, setProviderRaw] = useState<ProviderFilterValue>("all");
  const eventSourceRef = useRef<EventSource | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current provider scope, readable from the SSE handler (which subscribes
  // once with empty deps and would otherwise close over the initial value).
  const providerRef = useRef<ProviderFilterValue>("all");

  const pq = provider === "all" ? "" : `provider=${provider}`;

  // Switching provider must drop the merge-only caches, or agents from the tab
  // you just left would linger (SWR onSuccess and SSE both only ever add).
  const setProviderAndReset = useCallback((p: ProviderFilterValue) => {
    providerRef.current = p;
    setProviderRaw(p);
    setAgents(new Map());
    setEvents(new Map());
    setRecentActivity([]);
  }, []);

  // Initial fetch of all agents — each successful fetch seeds the agents map
  const { mutate: refetchAgents } = useSWR<AgentRecord[]>(
    `/api/monitor/agents?limit=200${pq ? `&${pq}` : ""}`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000,
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

  // Hydrate the Activity feed from the DB. Without this the feed only ever
  // holds events broadcast over SSE while the page is open — which looks fine
  // for Claude (hooks fire constantly during use) but leaves scopes fed by
  // ingestion, like Codex/OpenAI, permanently empty. Merge instead of replace:
  // SSE events may land while the fetch is in flight.
  const { mutate: refetchActivity } = useSWR<AgentEvent[]>(
    `/api/monitor/events?limit=${ACTIVITY_FEED_CAP}${pq ? `&${pq}` : ""}`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000,
      onSuccess: (fetched) => {
        // A fetch for the previous scope can resolve after a provider switch
        // already reset the feed — trim to the scope that's current *now* so
        // out-of-scope rows never occupy slots in the capped feed.
        const scope = providerRef.current;
        const inScope = scope === "all" ? fetched : fetched.filter((e) => e.provider === scope);
        setRecentActivity((prev) => mergeRecentActivity(prev, inScope));
      },
    }
  );

  // Fetch sessions
  const { data: sessionsData, mutate: refetchSessions } = useSWR<AgentSession[]>(
    `/api/monitor/sessions${pq ? `?${pq}` : ""}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 60_000 }
  );

  // Fetch stats
  const { data: stats, mutate: refetchStats } = useSWR<MonitorStats>(
    `/api/monitor/stats${pq ? `?${pq}` : ""}`,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 60_000 }
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
            // cap per-agent history at newest 200 in chronological order,
            // matching the fetch-hydration path. An uncapped array would be
            // an unbounded memory leak on long runs.
            const appended = existing.length >= MAX_AGENT_EVENTS
              ? [...existing.slice(existing.length - (MAX_AGENT_EVENTS - 1)), event]
              : [...existing, event];
            next.set(event.agent_id, appended);
            return next;
          });
          // Add to the recent activity feed — but only events in the current
          // provider scope. The feed is capped, so letting a chatty provider's
          // stream in while another is selected would evict the hydrated
          // history the user is actually looking at. The merge keeps order,
          // dedupes against rows the hydration fetch already delivered, and
          // enforces the cap.
          const scope = providerRef.current;
          if (scope === "all" || event.provider === scope) {
            setRecentActivity((prev) => mergeRecentActivity(prev, [event]));
          }
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
      const res = await fetch(`/api/monitor/events/${agentId}?limit=${MAX_AGENT_EVENTS}&order=desc`);
      const json: ApiResponse<AgentEvent[]> = await res.json();
      if (json.success && json.data) {
        // Server returns the newest N events in DESC order (newest first).
        // Reverse to restore chronological ASC order, matching what SSE
        // maintains in memory: every consumer expects events in timestamp
        // ascending order (oldest to newest for a timeline).
        setEvents((prev) => new Map(prev).set(agentId, json.data!.slice().reverse()));
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

  // Insertion into recentActivity is already scope-filtered (SSE and the
  // hydration fetch both check providerRef); this is a display-level safety
  // net for anything that slips through around a scope switch.
  const visibleActivity = useMemo(
    () => (provider === "all" ? recentActivity : recentActivity.filter((e) => e.provider === provider)),
    [recentActivity, provider]
  );

  const { workingAgents, idleAgents } = useMemo(() => {
    const working: AgentRecord[] = [];
    const idle: AgentRecord[] = [];
    for (const a of agentList) {
      if (a.status === "working") working.push(a);
      else if (a.status === "idle") idle.push(a);
    }
    return { workingAgents: working, idleAgents: idle };
  }, [agentList]);

  const refetchAll = useCallback(() => {
    refetchAgents();
    refetchActivity();
    refetchSessions();
    refetchStats();
  }, [refetchAgents, refetchActivity, refetchSessions, refetchStats]);

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
    setProvider: setProviderAndReset,
    agents: agentList,
    workingAgents,
    idleAgents,
    sessions: sessionsData || [],
    events,
    recentActivity: visibleActivity,
    stats: stats || null,
    connected,
    fetchAgentEvents,
    refetchAll,
    reset,
  };
}
