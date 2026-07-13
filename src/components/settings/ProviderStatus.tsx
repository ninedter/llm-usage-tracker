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
            <div key={p} className="flex items-center justify-between">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {info.displayName}
              </span>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    health.connected ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                />
                <span className="text-xs text-zinc-500">
                  {health.connected
                    ? "Connected"
                    : health.error || "Not configured"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
