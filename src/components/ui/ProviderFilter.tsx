"use client";

import type { DbProvider } from "@/types";

/** "all" means no filter — the API treats an unrecognised provider as unscoped. */
export type ProviderFilterValue = DbProvider | "all";

const OPTIONS: { value: ProviderFilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "anthropic", label: "Claude" },
  { value: "openai", label: "OpenAI" },
];

/** Serialise for a query string; "all" sends nothing so the server stays unscoped. */
export function providerParam(value: ProviderFilterValue): string {
  return value === "all" ? "" : `&provider=${value}`;
}

export function ProviderFilter({
  value,
  onChange,
}: {
  value: ProviderFilterValue;
  onChange: (value: ProviderFilterValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter by provider"
      className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-800"
    >
      {OPTIONS.map(({ value: option, label }) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`rounded-md px-3 py-1 text-base font-medium transition-colors ${
            value === option
              ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-600 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Small provider tag. Agents inherit their provider from their session, so this
 * is what tells a Codex agent apart from a Claude one at a glance.
 */
export function ProviderBadge({ provider }: { provider?: DbProvider }) {
  if (!provider) return null;
  const isOpenAI = provider === "openai";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        isOpenAI
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-violet-500/15 text-violet-700 dark:text-violet-400"
      }`}
    >
      {isOpenAI ? "OpenAI" : "Claude"}
    </span>
  );
}
