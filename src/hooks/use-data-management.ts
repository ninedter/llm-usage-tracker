"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { ApiResponse, StorageInfo, RetentionPolicy, PurgeCounts, PurgeResult } from "@/types";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as T;
}

export type PurgeWindow = number | "all";

export function useDataManagement() {
  const storage = useSWR<StorageInfo>("/api/monitor/storage", fetcher);
  const retention = useSWR<RetentionPolicy>("/api/monitor/retention", fetcher);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async (days: PurgeWindow): Promise<PurgeCounts> => {
    const q = days === "all" ? "all" : String(days);
    const data = await fetcher<{ cutoff_ms: number; would_delete: PurgeCounts }>(`/api/monitor/purge?days=${q}`);
    return data.would_delete;
  }, []);

  const purge = useCallback(async (days: PurgeWindow): Promise<PurgeResult> => {
    setBusy(true);
    try {
      const res = await fetch("/api/monitor/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const json: ApiResponse<PurgeResult> = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Purge failed");
      await storage.mutate();
      return json.data as PurgeResult;
    } finally {
      setBusy(false);
    }
  }, [storage]);

  const setRetention = useCallback(async (patch: { enabled?: boolean; days?: number }) => {
    try {
      const res = await fetch("/api/monitor/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json: ApiResponse<RetentionPolicy> = await res.json();
      if (json.success) {
        retention.mutate(json.data, { revalidate: false });
      } else {
        await retention.mutate(); // re-sync from server on failure
      }
    } catch {
      await retention.mutate(); // revert optimistic UI on network error
    }
  }, [retention]);

  return {
    storage: storage.data,
    storageError: storage.error,
    retention: retention.data,
    retentionError: retention.error,
    busy,
    preview,
    purge,
    setRetention,
    refreshStorage: storage.mutate,
  };
}
