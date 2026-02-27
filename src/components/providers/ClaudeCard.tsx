"use client";

import { useClaudeUsage } from "@/hooks/use-usage-data";
import { PROVIDER_INFO } from "@/lib/constants";
import { ProviderCard } from "@/components/dashboard/ProviderCard";
import { UsageBar } from "@/components/dashboard/UsageBar";
import { CardSkeleton } from "@/components/ui/Skeleton";

export function ClaudeCard({ enabled }: { enabled: boolean }) {
  const { data, error, isLoading } = useClaudeUsage(enabled);
  const info = PROVIDER_INFO.claude;

  if (!enabled) {
    return (
      <ProviderCard
        name={info.displayName}
        color={info.color}
        icon={<ClaudeIcon />}
        connected={false}
      >
        <p className="text-sm text-zinc-500">
          Configure credentials in Settings to track Claude usage.
        </p>
      </ProviderCard>
    );
  }

  if (isLoading) return <CardSkeleton />;

  return (
    <ProviderCard
      name={info.displayName}
      color={info.color}
      icon={<ClaudeIcon />}
      connected={!!data}
      lastUpdated={data?.lastUpdated}
      error={error?.message}
    >
      {data && (
        <>
          <UsageBar
            label="5-Hour Window"
            percentage={data.session.percentage}
            level={data.session.level}
            resetTime={data.session.resetTime}
          />
          <UsageBar
            label="7-Day Window"
            percentage={data.weekly.percentage}
            level={data.weekly.level}
            resetTime={data.weekly.resetTime}
          />

          {data.modelBreakdown.length > 0 && (
            <div className="ml-3 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
              {data.modelBreakdown.map(
                (m) =>
                  m.utilization != null &&
                  m.level && (
                    <UsageBar
                      key={m.modelId}
                      label={m.modelName}
                      percentage={m.utilization}
                      level={m.level}
                    />
                  )
              )}
            </div>
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Combined usage across claude.ai, Claude Code, and Claude Desktop.
          </p>
        </>
      )}
    </ProviderCard>
  );
}

function ClaudeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm-2-8c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" />
    </svg>
  );
}
