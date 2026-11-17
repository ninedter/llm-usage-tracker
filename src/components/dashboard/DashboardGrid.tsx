"use client";

import { ClaudeCard } from "@/components/providers/ClaudeCard";
import { OpenAICard } from "@/components/providers/OpenAICard";
import { GrokCard } from "@/components/providers/GrokCard";

export function DashboardGrid() {
  // No h-full on the grid: the row stays
  // content-sized so the cards never stretch with the monitor panel below
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <ClaudeCard />
      <OpenAICard />
      <GrokCard />
    </div>
  );
}
