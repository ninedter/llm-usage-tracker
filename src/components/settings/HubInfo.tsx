"use client";

import useSWR from "swr";
import type { ApiResponse, HubInfo as HubInfoData } from "@/types";

async function fetcher(url: string): Promise<HubInfoData> {
  const res = await fetch(url);
  const json: ApiResponse<HubInfoData> = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Fetch failed");
  return json.data as HubInfoData;
}

/**
 * Read-only view of the hub this UI is part of.
 *
 * The value comes from `GET /api/hub-info` rather than
 * `process.env.NEXT_PUBLIC_HUB_URL`: Next.js inlines `NEXT_PUBLIC_*` into the
 * client bundle at build time, so reading it here would show whatever the image
 * was built with instead of what the container was started with.
 */
export function HubInfo() {
  const { data, error } = useSWR<HubInfoData>("/api/hub-info", fetcher, {
    revalidateOnFocus: false,
  });

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Hub</h3>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        This tracker runs as a hub: one always-on container holding the canonical
        database, opened in any browser. Edge machines post their activity to the
        URL below (<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">NEXT_PUBLIC_HUB_URL</code>),
        and the Monitor and Analytics pages can be scoped to a single machine.
      </p>

      <div className="flex items-center gap-3">
        <label className="w-20 flex-shrink-0 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Hub URL
        </label>
        <code
          className="min-w-0 flex-1 truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          title={data?.hub_url}
        >
          {error ? "unavailable" : data?.hub_url ?? "…"}
        </code>
      </div>

      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Read-only here — set it in the hub&apos;s environment and restart the
        container.
      </p>
    </div>
  );
}
