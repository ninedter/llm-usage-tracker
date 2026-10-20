"use client";

import { useClaudeUsage } from "@/hooks/use-usage-data";
import { PROVIDER_INFO } from "@/lib/constants";
import { ProviderCard } from "@/components/dashboard/ProviderCard";
import { UsageBar } from "@/components/dashboard/UsageBar";
import { UsageStat } from "@/components/dashboard/UsageStat";
import { CreditSection } from "@/components/dashboard/CreditSection";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { formatMoney } from "@/lib/format";
import type { ClaudeExtraUsage, MoneyAmount } from "@/types";

export function ClaudeCard() {
  const { data, error, isLoading } = useClaudeUsage();
  const info = PROVIDER_INFO.claude;

  // A retry in flight after an error is not a first load: keep the error UI up
  if (isLoading && !data && !error) return <CardSkeleton />;

  // Only a definitive "no credentials" answer earns the setup placeholder —
  // even over stale data, so deleting credentials clears the card. Any other
  // failure keeps whatever data we have and shows the error banner.
  if (error?.code === "MISSING_CREDENTIALS") {
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

  return (
    <ProviderCard
      name={info.displayName}
      color={info.color}
      icon={<ClaudeIcon />}
      connected={!!data && !error}
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

          {(data.extraUsage || data.prepaidBalance) && (
            <ClaudeCredits extraUsage={data.extraUsage} prepaidBalance={data.prepaidBalance} />
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Combined usage across claude.ai, Claude Code, and Claude Desktop.
          </p>
        </>
      )}
    </ProviderCard>
  );
}

function ClaudeCredits({
  extraUsage: x,
  prepaidBalance,
}: {
  extraUsage: ClaudeExtraUsage | null;
  prepaidBalance: MoneyAmount | null;
}) {
  return (
    <CreditSection alert={x?.outOfCredits ? "Out of credits" : undefined}>
      {prepaidBalance && (
        <UsageStat
          label="Prepaid balance"
          value={formatMoney(prepaidBalance.amount, prepaidBalance.currency)}
        />
      )}

      {x &&
        (!x.enabled ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">Extra usage is off</p>
        ) : x.monthlyLimit != null ? (
          <div className="space-y-1">
            <UsageBar
              label="Extra usage this month"
              percentage={x.percentage ?? 0}
              level={x.level}
              used={formatMoney(x.used, x.currency)}
              limit={formatMoney(x.monthlyLimit, x.currency)}
            />
            {x.remaining != null && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatMoney(x.remaining, x.currency)} left
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">
              {formatMoney(x.used, x.currency)}
            </span>{" "}
            spent this month · no monthly cap
          </p>
        ))}
    </CreditSection>
  );
}

function ClaudeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm-2-8c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" />
    </svg>
  );
}
