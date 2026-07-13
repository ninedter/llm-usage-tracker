"use client";

import { useOpenAIUsage } from "@/hooks/use-usage-data";
import { PROVIDER_INFO } from "@/lib/constants";
import { ProviderCard } from "@/components/dashboard/ProviderCard";
import { UsageBar } from "@/components/dashboard/UsageBar";
import { CardSkeleton } from "@/components/ui/Skeleton";

export function OpenAICard({ enabled }: { enabled: boolean }) {
  const { data, error, isLoading } = useOpenAIUsage(enabled);
  const info = PROVIDER_INFO.openai;

  if (!enabled) {
    return (
      <ProviderCard
        name={info.displayName}
        color={info.color}
        icon={<OpenAIIcon />}
        connected={false}
      >
        <p className="text-sm text-zinc-500">
          Run <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">codex login</code>{" "}
          to connect your ChatGPT account and track OpenAI usage.
        </p>
      </ProviderCard>
    );
  }

  if (isLoading) return <CardSkeleton />;

  return (
    <ProviderCard
      name={info.displayName}
      color={info.color}
      icon={<OpenAIIcon />}
      connected={!!data}
      lastUpdated={data?.lastUpdated}
      error={error?.message}
    >
      {data && (
        <>
          {data.windows.map((w) => (
            <UsageBar
              key={w.label}
              label={w.label}
              percentage={w.percentage}
              level={w.level}
              resetTime={w.resetTime}
            />
          ))}

          {data.featureLimits.length > 0 && (
            <div className="ml-3 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
              {data.featureLimits.map((w) => (
                <UsageBar
                  key={w.label}
                  label={w.label}
                  percentage={w.percentage}
                  level={w.level}
                  resetTime={w.resetTime}
                />
              ))}
            </div>
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            ChatGPT{data.planType ? ` ${data.planType}` : ""} subscription usage
            via Codex CLI credentials.
          </p>
        </>
      )}
    </ProviderCard>
  );
}

function OpenAIIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}
