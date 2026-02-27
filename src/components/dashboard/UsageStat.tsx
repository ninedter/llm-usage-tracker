"use client";

interface UsageStatProps {
  label: string;
  value: string;
  subValue?: string;
}

export function UsageStat({ label, value, subValue }: UsageStatProps) {
  return (
    <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/50">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        {value}
      </p>
      {subValue && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">{subValue}</p>
      )}
    </div>
  );
}
