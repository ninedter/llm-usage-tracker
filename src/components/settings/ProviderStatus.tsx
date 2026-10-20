"use client";

import { useHealth } from "@/hooks/use-usage-data";
import { PROVIDER_INFO } from "@/lib/constants";
import type { ProviderId } from "@/types";

export function ProviderStatus() {
  const { data, isLoading } = useHealth();

  if (isLoading) {
    return (
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-500">Checking connections...</p>
      </div>
    );
  }

  if (!data) return null;

  const providers: ProviderId[] = ["claude", "openai"];

  return (
    <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Connection Status
      </h3>
      <div className="space-y-2">
        {providers.map((p) => {
          const health = data[p];
          const info = PROVIDER_INFO[p];
          return (
            <div key={p} className="flex items-center justify-between gap-4">
              <span className="flex-shrink-0 text-sm text-zinc-700 dark:text-zinc-300">
                {info.displayName}
              </span>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                    health.connected && !health.warning
                      ? "bg-emerald-500"
                      : health.configured
                        ? "bg-amber-500"
                        : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                />
                {health.connected && health.warning ? (
                  // Usage works, but a secondary credential (session key) lapsed
                  <span className="break-words text-right text-xs text-amber-600 dark:text-amber-400">
                    Connected · {health.warning}
                  </span>
                ) : health.connected ? (
                  <span className="text-xs text-zinc-500">Connected</span>
                ) : health.configured ? (
                  // Credentials exist but the upstream call failed (expired
                  // token, outage) — distinct from never having set it up
                  <span className="break-words text-right text-xs text-amber-600 dark:text-amber-400">
                    {health.error || "Connection failed"}
                  </span>
                ) : (
                  <span className="text-xs text-zinc-500">Not configured</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
