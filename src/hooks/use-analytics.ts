"use client";

import { useState, useCallback, useMemo } from "react";
import useSWR from "swr";
import { providerParam, type ProviderFilterValue } from "@/components/ui/ProviderFilter";
import type {
  ApiResponse,
  AnalyticsOverview,
  TrendPoint,
  SessionAnalyticRow,
  ToolAnalytics,
  FileAnalytics,
  ModelAnalytics,
  UsageInsights,
} from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

type Preset = "today" | "7d" | "30d" | "all";

export type AnalyticsTab = "insights" | "sessions" | "tools" | "files" | "models";

function presetToRange(preset: Preset): { from: number; to: number } {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { from: today.getTime(), to: now };
    case "7d":
      return { from: now - 7 * 86400000, to: now };
    case "30d":
      return { from: now - 30 * 86400000, to: now };
    case "all":
      return { from: 0, to: now };
  }
}

export function useAnalytics(activeTab: AnalyticsTab) {
  const [preset, setPresetState] = useState<Preset>("7d");
  const [customRange, setCustomRangeState] = useState<{ from: number; to: number } | null>(null);
  const [provider, setProvider] = useState<ProviderFilterValue>("all");

  const timeRange = useMemo(() => {
    if (customRange) return customRange;
    return presetToRange(preset);
  }, [preset, customRange]);

  const setPreset = useCallback((p: Preset) => {
    setPresetState(p);
    setCustomRangeState(null);
  }, []);

  const setCustomRange = useCallback((from: number, to: number) => {
    setCustomRangeState({ from, to });
  }, []);

  // Every panel below keys off `params`, so appending the provider here is what
  // scopes all seven queries at once.
  const params = `from=${timeRange.from}&to=${timeRange.to}${providerParam(provider)}`;
  const swrOpts = { revalidateOnFocus: false, refreshInterval: 60_000 };

  // Inactive tabs get a null SWR key: no fetch, no 60s polling, until the
  // tab is actually selected. overview + trends stay unconditional since
  // they're always visible above the tab strip.
  const tabKey = (tab: AnalyticsTab, url: string) => (activeTab === tab ? url : null);

  const { data: overview, isLoading: overviewLoading } = useSWR<AnalyticsOverview>(
    `/api/analytics/overview?${params}`, fetcher, swrOpts
  );

  const { data: trends, isLoading: trendsLoading } = useSWR<TrendPoint[]>(
    `/api/analytics/trends?${params}`, fetcher, swrOpts
  );

  const [sessionSort, setSessionSort] = useState<{ sort: string; order: string }>({ sort: "started_at", order: "desc" });
  const [sessionPage, setSessionPage] = useState(0);

  const { data: sessions, isLoading: sessionsLoading } = useSWR<SessionAnalyticRow[]>(
    tabKey("sessions", `/api/analytics/sessions?${params}&sort=${sessionSort.sort}&order=${sessionSort.order}&limit=20&offset=${sessionPage * 20}`),
    fetcher, swrOpts
  );

  const { data: toolAnalytics, isLoading: toolsLoading } = useSWR<ToolAnalytics>(
    tabKey("tools", `/api/analytics/tools?${params}`), fetcher, swrOpts
  );

  const { data: fileAnalytics, isLoading: filesLoading } = useSWR<FileAnalytics>(
    tabKey("files", `/api/analytics/files?${params}`), fetcher, swrOpts
  );

  const { data: modelAnalytics, isLoading: modelsLoading } = useSWR<ModelAnalytics>(
    tabKey("models", `/api/analytics/models?${params}`), fetcher, swrOpts
  );

  const { data: insights, isLoading: insightsLoading } = useSWR<UsageInsights>(
    tabKey("insights", `/api/analytics/insights?${params}`), fetcher, swrOpts
  );

  return {
    preset,
    timeRange,
    setPreset,
    setCustomRange,
    provider,
    setProvider,
    overview: overview || null,
    trends: trends || [],
    sessions: sessions || [],
    toolAnalytics: toolAnalytics || null,
    fileAnalytics: fileAnalytics || null,
    modelAnalytics: modelAnalytics || null,
    insights: insights || null,
    overviewLoading,
    trendsLoading,
    sessionsLoading,
    toolsLoading,
    filesLoading,
    modelsLoading,
    insightsLoading,
    sessionSort,
    setSessionSort,
    sessionPage,
    setSessionPage,
  };
}
