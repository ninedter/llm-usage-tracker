"use client";

import type { MachineSummary } from "@/types";

/** "all" means no machine scope — the API omits the filter entirely. */
export type MachineFilterValue = string;

export const ALL_MACHINES: MachineFilterValue = "all";

/** Serialise for a query string; "all" sends nothing so the server stays unscoped. */
export function machineParam(value: MachineFilterValue): string {
  return value === ALL_MACHINES ? "" : `&machine=${encodeURIComponent(value)}`;
}

/** Display name for a machine — the edge's label, or its id when it sent none. */
export function machineDisplayName(machine: MachineSummary): string {
  return machine.label?.trim() || machine.id;
}

// The monitor toolbar and the analytics header have different densities, so the
// same component renders in two skins rather than being forked into two files.
const VARIANTS = {
  default: {
    group: "flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-800",
    button: "rounded-md px-3 py-1 font-medium transition-colors",
    on: "bg-zinc-200 text-zinc-900 dark:bg-zinc-600 dark:text-zinc-100",
    off: "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
  },
  compact: {
    group: "flex items-center gap-0.5 border-l border-zinc-800 pl-2",
    button: "rounded px-1.5 py-0.5 font-medium transition-colors",
    on: "bg-zinc-700 text-zinc-200",
    off: "text-zinc-600 hover:text-zinc-400",
  },
} as const;

/**
 * All + one option per machine the hub has heard from, mirroring ProviderFilter.
 *
 * Renders nothing until a second machine shows up: on a single-machine install
 * "All" and that machine are the same view, and an always-visible filter with
 * one real choice is just noise.
 */
export function MachineFilter({
  machines,
  value,
  onChange,
  variant = "default",
  textClass = "text-base",
}: {
  machines: MachineSummary[];
  value: MachineFilterValue;
  onChange: (value: MachineFilterValue) => void;
  variant?: keyof typeof VARIANTS;
  textClass?: string;
}) {
  if (machines.length < 2) return null;

  const s = VARIANTS[variant];
  // Machines arrive from /api/machines already sorted by last_seen_at desc;
  // All stays pinned first so the default option never moves under the cursor.
  const options = [
    { value: ALL_MACHINES, label: "All" },
    ...machines.map((m) => ({ value: m.id, label: machineDisplayName(m) })),
  ];

  return (
    <div role="group" aria-label="Filter by machine" className={s.group}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          title={option.label}
          className={`max-w-[10rem] truncate ${s.button} ${textClass} ${
            value === option.value ? s.on : s.off
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
