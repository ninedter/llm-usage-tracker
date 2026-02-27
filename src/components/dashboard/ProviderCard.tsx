"use client";

import { ConnectionBadge } from "@/components/ui/StatusBadge";

interface ProviderCardProps {
  name: string;
  color: string;
  icon: React.ReactNode;
  connected: boolean;
  lastUpdated?: string;
  error?: string;
  children: React.ReactNode;
}

export function ProviderCard({
  name,
  color,
  icon,
  connected,
  lastUpdated,
  error,
  children,
}: ProviderCardProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header accent line */}
      <div className="h-1 flex-shrink-0" style={{ backgroundColor: color }} />

      <div className="flex flex-1 flex-col p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ backgroundColor: color + "20", color }}
            >
              {icon}
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {name}
            </h3>
          </div>
          <ConnectionBadge connected={connected} />
        </div>

        {/* Error state */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 space-y-4">{children}</div>

        {/* Footer */}
        {lastUpdated && (
          <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">
            Updated {formatRelativeTime(lastUpdated)}
          </p>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 10) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return `${Math.floor(diffSec / 3600)}h ago`;
  } catch {
    return "";
  }
}
