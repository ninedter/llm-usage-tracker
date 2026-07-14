"use client";

import { useHealth } from "@/hooks/use-usage-data";
import { ClaudeCard } from "@/components/providers/ClaudeCard";
import { OpenAICard } from "@/components/providers/OpenAICard";

export function DashboardGrid() {
  const { data: health } = useHealth();

  const claudeEnabled = !!health?.claude.connected;
  const openaiEnabled = !!health?.openai?.connected;

  // Claude top-left, OpenAI top-right. No h-full on the grid: the row stays
  // content-sized so the cards never stretch with the monitor panel below
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ClaudeCard enabled={claudeEnabled} />
      <OpenAICard enabled={openaiEnabled} />
    </div>
  );
}
