"use client";

import useSWR from "swr";
import type { ApiResponse, MachineSummary } from "@/types";

async function fetcher(url: string): Promise<MachineSummary[]> {
  const res = await fetch(url);
  const json: ApiResponse<MachineSummary[]> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data ?? [];
}

const EMPTY: MachineSummary[] = [];

/**
 * Machines the hub has heard from, newest activity first.
 *
 * Refreshed lazily (5 min): a machine appearing is rare compared to the 60 s
 * data polls, and this list only ever populates a filter's options.
 */
export function useMachines(): MachineSummary[] {
  const { data } = useSWR<MachineSummary[]>("/api/machines", fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 300_000,
  });
  return data ?? EMPTY;
}
