"use client";

import useSWR from "swr";
import type {
  ApiResponse,
  ClaudeUsageData,
  OpenAIUsageData,
  ProviderHealth,
} from "@/types";
import { REFRESH_INTERVALS } from "@/lib/constants";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

export function useClaudeUsage(enabled: boolean) {
  return useSWR<ClaudeUsageData>(
    enabled ? "/api/usage/claude" : null,
    fetcher,
    { refreshInterval: REFRESH_INTERVALS.usage, revalidateOnFocus: true }
  );
}

export function useOpenAIUsage(enabled: boolean) {
  return useSWR<OpenAIUsageData>(
    enabled ? "/api/usage/openai" : null,
    fetcher,
    { refreshInterval: REFRESH_INTERVALS.usage, revalidateOnFocus: true }
  );
}

export function useHealth() {
  return useSWR<ProviderHealth>("/api/health", fetcher, {
    refreshInterval: REFRESH_INTERVALS.billing,
    revalidateOnFocus: true,
  });
}
