"use client";

import type { UsageLevel } from "@/types";

const LEVEL_STYLES: Record<UsageLevel, string> = {
  safe: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  moderate: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

const LEVEL_LABELS: Record<UsageLevel, string> = {
  safe: "Normal",
  moderate: "Moderate",
  critical: "High",
};

export function StatusBadge({ level }: { level: UsageLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LEVEL_STYLES[level]}`}
    >
      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {LEVEL_LABELS[level]}
    </span>
  );
}

export type ConnectionStatus = "connected" | "error" | "unconfigured";

const CONNECTION_STYLES: Record<ConnectionStatus, string> = {
  connected: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  error: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  unconfigured: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connected: "Connected",
  error: "Error",
  unconfigured: "Not configured",
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CONNECTION_STYLES[status]}`}
    >
      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {CONNECTION_LABELS[status]}
    </span>
  );
}
