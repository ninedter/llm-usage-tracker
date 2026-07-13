"use client";

import { useHealth } from "@/hooks/use-usage-data";
import { ClaudeCard } from "@/components/providers/ClaudeCard";
import { OpenAICard } from "@/components/providers/OpenAICard";

export function DashboardGrid() {
  const { data: health } = useHealth();

  const claudeEnabled = !!health?.claude.connected;
  const openaiEnabled = !!health?.openai?.connected;

  // no h-full: cards stay content-sized so they never stretch with (or get
  // squeezed by) the viewport-capped column; the column scrolls if short
  return (
    <div className="grid grid-cols-1 gap-5">
      <ClaudeCard enabled={claudeEnabled} />
      <OpenAICard enabled={openaiEnabled} />
    </div>
  );
}
