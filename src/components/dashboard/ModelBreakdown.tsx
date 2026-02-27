"use client";

import { useState } from "react";
import type { ModelUsage } from "@/types";

interface ModelBreakdownProps {
  models: ModelUsage[];
}

export function ModelBreakdown({ models }: ModelBreakdownProps) {
  const [expanded, setExpanded] = useState(false);

  if (models.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
      >
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
        Model breakdown ({models.length})
      </button>
      {expanded && (
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50">
                <th className="px-3 py-1.5 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  Model
                </th>
                <th className="px-3 py-1.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Input
                </th>
                <th className="px-3 py-1.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Output
                </th>
                <th className="px-3 py-1.5 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={m.modelId}
                  className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/50"
                >
                  <td className="px-3 py-1.5 font-medium text-zinc-700 dark:text-zinc-300">
                    {m.modelName}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">
                    {formatTokens(m.inputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-600 dark:text-zinc-400">
                    {formatTokens(m.outputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium text-zinc-700 dark:text-zinc-300">
                    {formatTokens(m.totalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
