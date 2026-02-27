"use client";

import { useHealth } from "@/hooks/use-usage-data";
import { ClaudeCard } from "@/components/providers/ClaudeCard";

export function DashboardGrid() {
  const { data: health } = useHealth();

  const claudeEnabled = !!health?.claude.connected;

  return (
    <div className="grid h-full grid-cols-1 gap-5">
      <ClaudeCard enabled={claudeEnabled} />
    </div>
  );
}
