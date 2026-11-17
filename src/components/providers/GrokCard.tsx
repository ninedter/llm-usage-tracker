"use client";

import { useGrokUsage } from "@/hooks/use-usage-data";
import { PROVIDER_INFO, getUsageLevel } from "@/lib/constants";
import { formatMoney } from "@/lib/format";
import { ProviderCard } from "@/components/dashboard/ProviderCard";
import { UsageBar } from "@/components/dashboard/UsageBar";
import { CreditSection } from "@/components/dashboard/CreditSection";
import { CardSkeleton } from "@/components/ui/Skeleton";

export function GrokCard() {
  const { data, error, isLoading } = useGrokUsage();
  const info = PROVIDER_INFO.grok;

  if (isLoading && !data && !error) return <CardSkeleton />;

  if (error?.code === "MISSING_CREDENTIALS") {
    return (
      <ProviderCard name={info.displayName} color={info.color} icon={<GrokIcon />} connected={false}>
        <p className="text-sm text-zinc-500">
          Open the Grok Bot app while signed in. The tracker reads the usage it saves locally.
        </p>
      </ProviderCard>
    );
  }

  return (
    <ProviderCard
      name={info.displayName}
      color={info.color}
      icon={<GrokIcon />}
      connected={!!data && !error}
      lastUpdated={data?.lastUpdated}
      error={error?.message}
    >
      {data && (
        <>
          {data.weekly ? (
            <UsageBar label="7-Day Window" percentage={data.weekly.percentage} level={data.weekly.level} resetTime={data.weekly.resetTime} />
          ) : data.windowReset ? (
            <p className="text-sm text-zinc-500">Weekly window has reset since the last reading. Open Grok Bot to refresh.</p>
          ) : null}

          {!data.windowReset && data.stale && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Reading is more than a day old. Open Grok Bot to refresh.</p>
          )}

          {data.onDemand && (
            <CreditSection title="On-demand usage">
              {data.onDemand.limit !== null ? (
                <UsageBar
                  label="On-demand spend"
                  percentage={data.onDemand.limit > 0 ? data.onDemand.used / data.onDemand.limit * 100 : (data.onDemand.used > 0 ? 100 : 0)}
                  level={getUsageLevel(data.onDemand.limit > 0 ? data.onDemand.used / data.onDemand.limit * 100 : (data.onDemand.used > 0 ? 100 : 0))}
                  used={formatMoney(data.onDemand.used, data.onDemand.currency)}
                  limit={formatMoney(data.onDemand.limit, data.onDemand.currency)}
                />
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {formatMoney(data.onDemand.used, data.onDemand.currency)} spent · no limit
                </p>
              )}
            </CreditSection>
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Grok{data.planName ? ` ${data.planName}` : ""} subscription usage via Grok Bot&apos;s local cache.{data.isTrial ? " Trial." : ""}
          </p>
        </>
      )}
    </ProviderCard>
  );
}

function GrokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="h-4 w-4">
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 17.5 17.5 6.5" />
    </svg>
  );
}
